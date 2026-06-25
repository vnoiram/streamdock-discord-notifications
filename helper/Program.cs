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
    private static readonly ConcurrentDictionary<string, byte> SubscribedApps = new(StringComparer.OrdinalIgnoreCase);
    private static TypedEventHandler<UserNotificationListener, UserNotificationChangedEventArgs>? _notificationChangedHandler;
    private static LatestNotification? _latest;
    private static string? _logFile;
    private static string? _historyFile;
    private static int _maxHistory = 50;
    private static string _defaultApp = "Discord";

    private static async Task Main(string[] args)
    {
        var prefix = args.FirstOrDefault(arg => arg.StartsWith("--prefix=", StringComparison.OrdinalIgnoreCase))?.Split('=', 2)[1]
            ?? Environment.GetEnvironmentVariable("STREAMDOCK_DISCORD_HELPER_PREFIX")
            ?? DefaultPrefix;
        _logFile = args.FirstOrDefault(arg => arg.StartsWith("--log-file=", StringComparison.OrdinalIgnoreCase))?.Split('=', 2)[1]
            ?? Environment.GetEnvironmentVariable("STREAMDOCK_DISCORD_HELPER_LOG");
        _historyFile = args.FirstOrDefault(arg => arg.StartsWith("--history-file=", StringComparison.OrdinalIgnoreCase))?.Split('=', 2)[1]
            ?? Environment.GetEnvironmentVariable("STREAMDOCK_DISCORD_HISTORY_FILE")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StreamDock", "discord-notifications-history.json");
        _defaultApp = args.FirstOrDefault(arg => arg.StartsWith("--app=", StringComparison.OrdinalIgnoreCase))?.Split('=', 2)[1]
            ?? Environment.GetEnvironmentVariable("STREAMDOCK_NOTIFICATION_APP")
            ?? "Discord";
        _maxHistory = Math.Clamp(ParseIntArg(args, "--max-history=") ?? ParseIntEnv("STREAMDOCK_DISCORD_MAX_HISTORY") ?? 50, 1, 500);
        SubscribedApps[_defaultApp] = 0;

        LoadHistory();
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

        _latest = await FindLatestNotificationAsync(_defaultApp);
        _notificationChangedHandler = async (_, args) =>
        {
            if (args.ChangeKind is UserNotificationChangedKind.Added or UserNotificationChangedKind.Changed)
            {
                foreach (var app in SubscribedApps.Keys.DefaultIfEmpty(_defaultApp))
                {
                    var latest = await FindLatestNotificationAsync(app);
                    if (latest is not null)
                    {
                        _latest = latest;
                        AddHistory(latest, persist: true);
                        Log($"notification: {latest.AppName}:{latest.Sender}");
                        await BroadcastAsync(new
                        {
                            @event = "notification",
                            app = latest.AppName,
                            sender = latest.Sender,
                            body = latest.Body,
                            preview = latest.PreviewAvailable
                        });
                    }
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
                SubscribedApps[command.App ?? _defaultApp] = 0;
                await SendPermissionAsync(socket);
            }
            else if (command?.Command is "configure")
            {
                ConfigureHistory(command.HistoryFile, command.MaxHistory);
                await SendAsync(socket, new { @event = "configured", maxHistory = _maxHistory, historyFile = _historyFile });
            }
            else if (command?.Command is "latest")
            {
                _latest = await FindLatestNotificationAsync(command.App ?? _defaultApp);
                if (_latest is null)
                {
                    await SendAsync(socket, new { @event = "preview_unavailable", sender = "" });
                }
                else
                {
                    AddHistory(_latest, command.Persist ?? true);
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
                    items = GetHistory(command.Limit, command.App)
                });
            }
            else if (command?.Command is "senders")
            {
                await SendAsync(socket, new
                {
                    @event = "senders",
                    app = command.App ?? _defaultApp,
                    senders = GetSenders(command.App)
                });
            }
            else if (command?.Command is "clear")
            {
                lock (HistoryLock)
                {
                    if (string.IsNullOrWhiteSpace(command.App))
                    {
                        History.Clear();
                    }
                    else
                    {
                        History.RemoveAll(item => IsTargetApp(item.AppName, command.App));
                    }
                }
                SaveHistory();
                await SendAsync(socket, new { @event = "history", items = Array.Empty<object>() });
            }
            else if (command?.Command is "mark_read")
            {
                lock (HistoryLock)
                {
                    History.RemoveAll(item =>
                        (string.IsNullOrWhiteSpace(command.App) || IsTargetApp(item.AppName, command.App)) &&
                        SenderMatches(item.Sender, command.Sender, command.SenderMatchMode));
                }
                SaveHistory();
                await SendAsync(socket, new { @event = "history", items = GetHistory(command.Limit, command.App) });
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

    private static async Task<LatestNotification?> FindLatestNotificationAsync(string app)
    {
        var notifications = await Listener.GetNotificationsAsync(NotificationKinds.Toast);
        var discordNotifications = notifications
            .Select(ReadNotification)
            .Where(notification => notification is not null)
            .Cast<LatestNotification>()
            .Where(notification => IsTargetApp(notification.AppName, app))
            .OrderByDescending(notification => notification.Created)
            .ToList();

        return discordNotifications.FirstOrDefault();
    }

    private static void AddHistory(LatestNotification notification, bool persist)
    {
        lock (HistoryLock)
        {
            if (History.Count > 0 && History[0].Created == notification.Created && History[0].Sender == notification.Sender)
            {
                return;
            }
            History.Insert(0, notification);
            if (History.Count > _maxHistory)
            {
                History.RemoveRange(_maxHistory, History.Count - _maxHistory);
            }
        }
        if (persist)
        {
            SaveHistory();
        }
    }

    private static object[] GetHistory(int? limit, string? app)
    {
        var take = Math.Clamp(limit ?? 10, 1, _maxHistory);
        lock (HistoryLock)
        {
            return History
                .Where(item => string.IsNullOrWhiteSpace(app) || IsTargetApp(item.AppName, app))
                .Take(take).Select(item => new
            {
                app = item.AppName,
                sender = item.Sender,
                body = item.Body,
                preview = item.PreviewAvailable,
                time = item.Created.ToUnixTimeMilliseconds()
            }).Cast<object>().ToArray();
        }
    }

    private static string[] GetSenders(string? app)
    {
        lock (HistoryLock)
        {
            return History
                .Where(item => string.IsNullOrWhiteSpace(app) || IsTargetApp(item.AppName, app))
                .Select(item => item.Sender)
                .Where(sender => !string.IsNullOrWhiteSpace(sender))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(sender => sender, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
    }

    private static bool SenderMatches(string sender, string? filter, string? mode)
    {
        if (string.IsNullOrWhiteSpace(filter))
        {
            return true;
        }
        return string.Equals(mode, "exact", StringComparison.OrdinalIgnoreCase)
            ? sender.Equals(filter, StringComparison.OrdinalIgnoreCase)
            : sender.Contains(filter, StringComparison.OrdinalIgnoreCase);
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

    private static bool IsTargetApp(string appName, string? targetApp)
    {
        return appName.Contains(string.IsNullOrWhiteSpace(targetApp) ? "Discord" : targetApp, StringComparison.OrdinalIgnoreCase);
    }

    private static void LoadHistory()
    {
        if (string.IsNullOrWhiteSpace(_historyFile) || !File.Exists(_historyFile))
        {
            lock (HistoryLock)
            {
                History.Clear();
            }
            return;
        }
        try
        {
            var items = JsonSerializer.Deserialize<List<LatestNotification>>(File.ReadAllText(_historyFile), JsonOptions);
            if (items is null)
            {
                return;
            }
            lock (HistoryLock)
            {
                History.Clear();
                History.AddRange(items.Take(_maxHistory));
            }
        }
        catch (Exception error)
        {
            Log($"load history failed: {error.Message}");
        }
    }

    private static void SaveHistory()
    {
        if (string.IsNullOrWhiteSpace(_historyFile))
        {
            return;
        }
        try
        {
            var directory = Path.GetDirectoryName(_historyFile);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }
            lock (HistoryLock)
            {
                File.WriteAllText(_historyFile, JsonSerializer.Serialize(History.Take(_maxHistory), JsonOptions));
            }
        }
        catch (Exception error)
        {
            Log($"save history failed: {error.Message}");
        }
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

    private static void ConfigureHistory(string? historyFile, int? maxHistory)
    {
        if (!string.IsNullOrWhiteSpace(historyFile) && !historyFile.Equals(_historyFile, StringComparison.OrdinalIgnoreCase))
        {
            _historyFile = ExpandEnvironmentPath(historyFile);
            LoadHistory();
        }
        if (maxHistory is not null)
        {
            _maxHistory = Math.Clamp(maxHistory.Value, 1, 500);
            lock (HistoryLock)
            {
                if (History.Count > _maxHistory)
                {
                    History.RemoveRange(_maxHistory, History.Count - _maxHistory);
                }
            }
            SaveHistory();
        }
    }

    private static string ExpandEnvironmentPath(string path)
    {
        return Environment.ExpandEnvironmentVariables(path);
    }

    private static int? ParseIntArg(string[] args, string prefix)
    {
        var raw = args.FirstOrDefault(arg => arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))?.Split('=', 2)[1];
        return int.TryParse(raw, out var value) ? value : null;
    }

    private static int? ParseIntEnv(string name)
    {
        return int.TryParse(Environment.GetEnvironmentVariable(name), out var value) ? value : null;
    }

    private sealed record HelperCommand(string? Command, string? App, int? Limit, bool? Persist, string? Sender, string? SenderMatchMode, string? HistoryFile, int? MaxHistory);

    private sealed record LatestNotification(
        string AppName,
        string Sender,
        string Body,
        bool PreviewAvailable,
        DateTimeOffset Created);
}
