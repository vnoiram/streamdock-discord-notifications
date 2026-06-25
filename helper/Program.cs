using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using Windows.Foundation;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;

namespace DiscordNotificationHelper;

[SupportedOSPlatform("windows10.0.17763.0")]
internal static class Program
{
    private const string DefaultPrefix = "http://127.0.0.1:41921/";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly ConcurrentDictionary<Guid, WebSocket> Clients = new();
    private static readonly UserNotificationListener Listener = UserNotificationListener.Current;
    private static readonly object HistoryLock = new();
    private static readonly List<LatestNotification> History = new();
    private static TypedEventHandler<UserNotificationListener, UserNotificationChangedEventArgs>? _notificationChangedHandler;
    private static LatestNotification? _latest;
    private static string? _logFile;

    private static async Task Main(string[] args)
    {
        var prefix = args.FirstOrDefault(arg => arg.StartsWith("--prefix=", StringComparison.OrdinalIgnoreCase))?.Split('=', 2)[1]
            ?? Environment.GetEnvironmentVariable("STREAMDOCK_DISCORD_HELPER_PREFIX")
            ?? DefaultPrefix;
        _logFile = args.FirstOrDefault(arg => arg.StartsWith("--log-file=", StringComparison.OrdinalIgnoreCase))?.Split('=', 2)[1]
            ?? Environment.GetEnvironmentVariable("STREAMDOCK_DISCORD_HELPER_LOG");

        var access = await EnsureAccessAsync();
        Log($"notification access: {access}");
        await StartNotificationWatcherAsync(access);
        await RunServerAsync(prefix);
    }

    private static async Task<UserNotificationListenerAccessStatus> EnsureAccessAsync()
    {
        var access = await Listener.RequestAccessAsync();
        return access;
    }

    private static async Task StartNotificationWatcherAsync(UserNotificationListenerAccessStatus access)
    {
        if (access != UserNotificationListenerAccessStatus.Allowed)
        {
            return;
        }

        _latest = await FindLatestDiscordNotificationAsync();
        _notificationChangedHandler = async (_, args) =>
        {
            if (args.ChangeKind is UserNotificationChangedKind.Added or UserNotificationChangedKind.Changed)
            {
                _latest = await FindLatestDiscordNotificationAsync();
                if (_latest is not null)
                {
                    AddHistory(_latest);
                    Log($"notification: {_latest.Sender}");
                    await BroadcastAsync(new
                    {
                        @event = "notification",
                        sender = _latest.Sender,
                        body = _latest.Body,
                        preview = _latest.PreviewAvailable
                    });
                }
            }
        };
        Listener.NotificationChanged += _notificationChangedHandler;
    }

    private static async Task RunServerAsync(string prefix)
    {
        using var listener = new HttpListener();
        listener.Prefixes.Add(prefix);
        listener.Start();
        Console.WriteLine($"Discord notification helper listening on {prefix}");
        Log($"listening on {prefix}");

        while (true)
        {
            var context = await listener.GetContextAsync();
            _ = Task.Run(() => HandleContextAsync(context));
        }
    }

    private static async Task HandleContextAsync(HttpListenerContext context)
    {
        if (!context.Request.IsWebSocketRequest)
        {
            context.Response.StatusCode = 426;
            context.Response.Close();
            return;
        }

        var id = Guid.NewGuid();
        using var webSocketContext = await context.AcceptWebSocketAsync(subProtocol: null);
        var socket = webSocketContext.WebSocket;
        Clients[id] = socket;

        await SendPermissionAsync(socket);
        if (_latest is not null)
        {
            await SendAsync(socket, new
            {
                @event = "notification",
                sender = _latest.Sender,
                body = _latest.Body,
                preview = _latest.PreviewAvailable
            });
        }

        try
        {
            await ReceiveLoopAsync(socket);
        }
        finally
        {
            Clients.TryRemove(id, out _);
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "closing", CancellationToken.None);
            }
        }
    }

    private static async Task ReceiveLoopAsync(WebSocket socket)
    {
        var buffer = new byte[4096];
        while (socket.State == WebSocketState.Open)
        {
            var result = await socket.ReceiveAsync(buffer, CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            var text = Encoding.UTF8.GetString(buffer, 0, result.Count);
            var command = JsonSerializer.Deserialize<HelperCommand>(text, JsonOptions);
            if (command?.Command is "subscribe")
            {
                await SendPermissionAsync(socket);
            }
            else if (command?.Command is "latest")
            {
                _latest = await FindLatestDiscordNotificationAsync();
                if (_latest is null)
                {
                    await SendAsync(socket, new { @event = "preview_unavailable", sender = "" });
                }
                else
                {
                    AddHistory(_latest);
                    await SendAsync(socket, new
                    {
                        @event = "notification",
                        sender = _latest.Sender,
                        body = _latest.Body,
                        preview = _latest.PreviewAvailable
                    });
                }
            }
            else if (command?.Command is "history")
            {
                await SendAsync(socket, new
                {
                    @event = "history",
                    items = GetHistory(command.Limit)
                });
            }
            else if (command?.Command is "clear")
            {
                lock (HistoryLock)
                {
                    History.Clear();
                }
                await SendAsync(socket, new { @event = "history", items = Array.Empty<object>() });
            }
        }
    }

    private static async Task SendPermissionAsync(WebSocket socket)
    {
        var access = await EnsureAccessAsync();
        await SendAsync(socket, new
        {
            @event = "permission",
            status = access == UserNotificationListenerAccessStatus.Allowed ? "granted" : "denied"
        });

        if (access == UserNotificationListenerAccessStatus.Allowed && _notificationChangedHandler is null)
        {
            await StartNotificationWatcherAsync(access);
        }
    }

    private static async Task<LatestNotification?> FindLatestDiscordNotificationAsync()
    {
        var notifications = await Listener.GetNotificationsAsync(NotificationKinds.Toast);
        var discordNotifications = notifications
            .Select(ReadNotification)
            .Where(notification => notification is not null)
            .Cast<LatestNotification>()
            .Where(notification => IsDiscord(notification.AppName))
            .OrderByDescending(notification => notification.Created)
            .ToList();

        return discordNotifications.FirstOrDefault();
    }

    private static void AddHistory(LatestNotification notification)
    {
        lock (HistoryLock)
        {
            if (History.Count > 0 && History[0].Created == notification.Created && History[0].Sender == notification.Sender)
            {
                return;
            }
            History.Insert(0, notification);
            if (History.Count > 50)
            {
                History.RemoveRange(50, History.Count - 50);
            }
        }
    }

    private static object[] GetHistory(int? limit)
    {
        var take = Math.Clamp(limit ?? 10, 1, 50);
        lock (HistoryLock)
        {
            return History.Take(take).Select(item => new
            {
                sender = item.Sender,
                body = item.Body,
                preview = item.PreviewAvailable,
                time = item.Created.ToUnixTimeMilliseconds()
            }).Cast<object>().ToArray();
        }
    }

    private static LatestNotification? ReadNotification(UserNotification notification)
    {
        var appName = notification.AppInfo.DisplayInfo.DisplayName;
        var binding = notification.Notification.Visual.GetBinding(KnownNotificationBindings.ToastGeneric);
        if (binding is null)
        {
            return null;
        }

        var texts = binding.GetTextElements().Select(element => element.Text).Where(text => !string.IsNullOrWhiteSpace(text)).ToList();
        if (texts.Count == 0)
        {
            return new LatestNotification(appName, appName, string.Empty, false, notification.CreationTime);
        }

        var sender = texts[0];
        var body = texts.Count > 1 ? string.Join(" ", texts.Skip(1)) : string.Empty;
        return new LatestNotification(appName, sender, body, !string.IsNullOrWhiteSpace(body), notification.CreationTime);
    }

    private static bool IsDiscord(string appName)
    {
        return appName.Contains("Discord", StringComparison.OrdinalIgnoreCase);
    }

    private static async Task BroadcastAsync(object payload)
    {
        foreach (var socket in Clients.Values)
        {
            if (socket.State == WebSocketState.Open)
            {
                await SendAsync(socket, payload);
            }
        }
    }

    private static async Task SendAsync(WebSocket socket, object payload)
    {
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        var bytes = Encoding.UTF8.GetBytes(json);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None);
    }

    private static void Log(string message)
    {
        var line = $"{DateTimeOffset.Now:O} {message}";
        Console.WriteLine(line);
        if (!string.IsNullOrWhiteSpace(_logFile))
        {
            File.AppendAllText(_logFile, line + Environment.NewLine);
        }
    }

    private sealed record HelperCommand(string? Command, string? App, int? Limit);

    private sealed record LatestNotification(
        string AppName,
        string Sender,
        string Body,
        bool PreviewAvailable,
        DateTimeOffset Created);
}
