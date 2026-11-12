using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Media;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Timer = System.Windows.Forms.Timer;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var verify = args.Length == 1 && args[0] == "--verify";
        bool first;
        using (var instance = new Mutex(true, "Local\\FieldLinkWindows" + (verify ? ".Verification" : ""), out first))
        {
            if (!first) { if (!verify) MessageBox.Show("Field Link is already open. Look for its icon in the Windows notification area.", "Field Link"); return; }
            try
            {
                if (verify) Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                string data = Environment.GetEnvironmentVariable("FIELD_LINK_WINDOWS_DATA");
                if (string.IsNullOrEmpty(data)) data = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                    verify ? "Verification-" + Guid.NewGuid().ToString("N") : "Field Link Data");
                Directory.CreateDirectory(data);
                var config = ReadResource("hub.txt").Trim().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var hub = new Hub(config[0], config[1], data);
                Application.Run(new Window(hub, data, verify));
            }
            catch (Exception error)
            {
                Environment.ExitCode = 1;
                if (!verify) MessageBox.Show(error.Message, "Field Link could not start");
            }
        }
    }

    internal static string ReadResource(string name)
    {
        using (var reader = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream(name))) return reader.ReadToEnd();
    }
}

[ComVisible(true), ClassInterface(ClassInterfaceType.AutoDual)]
public sealed class SessionBridge
{
    private readonly Func<string> read;
    internal SessionBridge(Func<string> read) { this.read = read; }
    public string RestoreSession() { return read(); }
}

internal sealed class Window : Form
{
    private readonly Hub hub;
    private readonly string data;
    private readonly bool verify;
    private readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(9, 28, 44) };
    private readonly Label status = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White };
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly Timer watch = new Timer { Interval = 3200 };
    private readonly Timer ringtone = new Timer { Interval = 2300 };
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 12 };
    private readonly SemaphoreSlim webRequests = new SemaphoreSlim(1, 1);
    private string token, incoming = "";
    private long boot, cursor;
    private bool watching, exiting, alerts = true, foregroundRing;
    private DateTime ringUntil;

    public Window(Hub hub, string data, bool verify)
    {
        this.hub = hub; this.data = data; this.verify = verify;
        token = hub.LoadSession();
        TraceCheck("Window constructed");
        Text = "Field Link";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Width = 1050; Height = 760; MinimumSize = new Size(400, 560);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(9, 28, 44);
        Controls.Add(view); Controls.Add(status);
        status.Text = "Connecting to the ESP32…"; status.BringToFront();
        tray.Icon = Icon; tray.Text = "Field Link"; tray.Visible = !verify;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Field Link", null, (s, e) => Reveal());
        var allow = new ToolStripMenuItem("Show background alerts") { Checked = true, CheckOnClick = true };
        allow.CheckedChanged += (s, e) => { alerts = allow.Checked; if (!alerts) StopRing(); };
        menu.Items.Add(allow);
        menu.Items.Add("Exit Field Link", null, (s, e) => ExitWindow(0));
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (s, e) => Reveal(); tray.BalloonTipClicked += (s, e) => Reveal();
        ringtone.Tick += (s, e) => { if (DateTime.UtcNow < ringUntil) SystemSounds.Exclamation.Play(); else StopRing(); };
        watch.Tick += (s, e) => WatchAsync();
        Activated += (s, e) => { if (!foregroundRing) StopRing(); };
        Shown += (s, e) => InitializeAsync();
        FormClosing += (s, e) =>
        {
            if (!exiting && !verify && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
        };
        FormClosed += (s, e) => { watch.Dispose(); ringtone.Dispose(); tray.Dispose(); };
    }

    private bool Foreground { get { return Visible && WindowState != FormWindowState.Minimized && (ContainsFocus || ActiveForm == this); } }

    private async void InitializeAsync()
    {
        try
        {
            TraceCheck("Initializing WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(data, "WebView2"));
            await view.EnsureCoreWebView2Async(environment);
            TraceCheck("WebView2 initialized");
            var core = view.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            core.NavigationStarting += (s, e) => { if (!hub.Owns(e.Uri)) e.Cancel = true; else { foregroundRing = false; StopRing(); } };
            core.FrameNavigationStarting += (s, e) => e.Cancel = true;
            core.NewWindowRequested += (s, e) => e.Handled = true;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (s, e) => ForwardRequest(environment, e);
            core.PermissionRequested += (s, e) =>
            {
                if (!hub.Owns(e.Uri) || (e.PermissionKind != CoreWebView2PermissionKind.Camera &&
                    e.PermissionKind != CoreWebView2PermissionKind.Microphone && e.PermissionKind != CoreWebView2PermissionKind.Geolocation))
                    e.State = CoreWebView2PermissionState.Deny;
            };
            core.DownloadStarting += SavePhoto;
            core.WebMessageReceived += Receive;
            core.AddHostObjectToScript("fieldLink", new SessionBridge(() => token));
            await core.AddScriptToExecuteOnDocumentCreatedAsync(Program.ReadResource("bridge.js").Replace("__HUB_ORIGIN__", hub.Origin.GetLeftPart(UriPartial.Authority)));
            core.NavigationCompleted += NavigationCompleted;
            core.Navigate(hub.Origin.AbsoluteUri);
            if (!verify) watch.Start();
        }
        catch (Exception e) { TraceCheck(e.GetType().Name); ShowError(e.Message); if (verify) ExitWindow(2); }
    }

    private async void ForwardRequest(CoreWebView2Environment environment, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var request = e.Request;
        var address = request.Uri; var method = request.Method;
        if (OwnBlob(address)) return;
        if (!hub.Allows(address, method))
        {
            e.Response = environment.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain\r\n");
            return;
        }
        using (e.GetDeferral())
        {
            try
            {
                var auth = Header(request, "Authorization");
                var bearer = auth != null && auth.StartsWith("Bearer ", StringComparison.Ordinal) ? auth.Substring(7) : null;
                var contentType = Header(request, "Content-Type");
                var recipient = Header(request, "X-Recipient");
                var content = method == "POST" ? Hub.ReadBounded(request.Content, 102400) : null;
                HubResponse reply;
                await webRequests.WaitAsync();
                try { reply = await Task.Run(() => hub.Fetch(address, method, contentType, bearer, recipient, content)); }
                finally { webRequests.Release(); }
                TraceCheck("Hub response: " + reply.Status);
                e.Response = environment.CreateWebResourceResponse(new MemoryStream(reply.Content, false), reply.Status, "Hub", reply.Headers);
            }
            catch (Exception error)
            {
                TraceCheck("Hub request failed: " + error.GetType().Name);
                if (!exiting) e.Response = environment.CreateWebResourceResponse(
                    new MemoryStream(Encoding.UTF8.GetBytes("{\"error\":\"Could not reach the trusted ESP32.\"}")),
                    503, "Hub unavailable", "Content-Type: application/json\r\nCache-Control: no-store\r\n");
            }
        }
    }

    private static string Header(CoreWebView2WebResourceRequest request, string name)
    { return request.Headers.Contains(name) ? request.Headers.GetHeader(name) : null; }

    private void SavePhoto(object sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var name = Path.GetFileName(e.ResultFilePath);
        if (!OwnBlob(e.DownloadOperation.Uri) || name == null || !Regex.IsMatch(name, "^Field-Link-[a-f0-9]{8}(?: \\(\\d+\\))?\\.jpg$"))
        { e.Cancel = true; return; }
        e.Handled = true;
        var deferral = e.GetDeferral();
        BeginInvoke((Action)(() =>
        {
            using (deferral)
            {
                using (var dialog = new SaveFileDialog { FileName = name, Filter = "JPEG photo|*.jpg", DefaultExt = "jpg", AddExtension = true, OverwritePrompt = true })
                {
                    if (dialog.ShowDialog(this) == DialogResult.OK) e.ResultFilePath = dialog.FileName;
                    else e.Cancel = true;
                }
            }
        }));
    }

    private async void NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        TraceCheck("Navigation: " + e.WebErrorStatus);
        if (!e.IsSuccess || e.HttpStatusCode >= 400)
        {
            ShowError("Could not reach the trusted ESP32. Join the router network, then double-click here to reconnect.\n" + e.WebErrorStatus);
            return;
        }
        status.Visible = false;
        if (!verify) return;
        try
        {
            string result = await view.CoreWebView2.ExecuteScriptAsync("Boolean(isSecureContext && document.querySelector('#settings-sheet') && typeof window.checkUpdate === 'function' && window.FieldLinkNative?.restoreSession() === '')");
            if (result != "true") { ExitWindow(3); return; }
            await view.CoreWebView2.ExecuteScriptAsync("void (async()=>{for(let i=0;i<3;i++){const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:'{\"action\":\"poll\"}'});if(r.status!==401){window.__fieldLinkVerification=r.status;return;}}window.__fieldLinkVerification=401;})()");
            string browserStatus = "";
            for (var i = 0; i < 40 && browserStatus != "401"; i++)
            {
                await Task.Delay(250);
                browserStatus = await view.CoreWebView2.ExecuteScriptAsync("window.__fieldLinkVerification || 0");
            }
            if (browserStatus != "401") { ExitWindow(7); return; }
            var fixture = new string('a', 64);
            hub.SaveSession(fixture);
            try { if (hub.LoadSession() != fixture) { ExitWindow(5); return; } }
            finally { hub.SaveSession(""); }
            var denied = await Task.Run(() =>
            {
                var response = hub.Fetch(new Uri(hub.Origin, "/api").AbsoluteUri, "POST", "application/json", fixture, null,
                    Encoding.UTF8.GetBytes("{\"action\":\"watch\"}"));
                return response.Status == 401;
            });
            ExitWindow(denied ? 0 : 6);
        }
        catch { ExitWindow(4); }
    }

    private void ShowError(string message)
    {
        status.Text = message; status.Visible = true; status.BringToFront();
        status.DoubleClick -= Retry; status.DoubleClick += Retry;
    }

    private void Retry(object sender, EventArgs e) { if (view.CoreWebView2 != null) view.CoreWebView2.Navigate(hub.Origin.AbsoluteUri); }

    private bool OwnBlob(string address)
    {
        return address != null && address.StartsWith("blob:" + hub.Origin.GetLeftPart(UriPartial.Authority) + "/", StringComparison.Ordinal);
    }

    private void Receive(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!hub.Owns(e.Source) || e.WebMessageAsJson.Length > 512) return;
        try
        {
            var message = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            object value;
            if (message == null || !message.TryGetValue("value", out value)) return;
            var kind = TextValue(message, "kind");
            var item = value as Dictionary<string, object>;
            if ((kind == "session" || kind == "cursor") && item != null)
            {
                if (kind == "session")
                {
                    var newToken = TextValue(item, "token");
                    if (newToken == null || (newToken.Length != 0 && !Hub.IsToken(newToken))) return;
                    if (newToken != token) { token = newToken; boot = cursor = 0; hub.SaveSession(newToken); }
                }
                var nextBoot = Number(item, "boot"); var nextCursor = Number(item, "cursor");
                if (nextBoot > 0 && (Foreground || kind == "session"))
                { if (boot != nextBoot) { boot = nextBoot; cursor = 0; } cursor = Math.Max(cursor, nextCursor); }
            }
            else if (kind == "ring" && value is bool)
            {
                if (Foreground)
                {
                    foregroundRing = (bool)value;
                    if (foregroundRing) StartRing(); else StopRing();
                }
                else if (!(bool)value && foregroundRing)
                {
                    foregroundRing = false;
                    if (incoming.Length == 0) StopRing();
                }
            }
            else if (kind == "settings" && Foreground)
            {
                var target = value as string;
                if (target == "alerts") Process.Start("ms-settings:notifications");
                if (target == "permissions") Process.Start("ms-settings:privacy");
                if (target == "hub") MessageBox.Show(this, hub.Origin.GetLeftPart(UriPartial.Authority), "Trusted hub address");
            }
        }
        catch (Exception e1)
        {
            if (e1 is IOException || e1 is UnauthorizedAccessException || e1 is System.Security.Cryptography.CryptographicException)
                MessageBox.Show(this, "Windows could not save the Field Link session in the app folder.", "Field Link");
        }
    }

    private async void WatchAsync()
    {
        if (watching || Foreground || !alerts || !Hub.IsToken(token)) return;
        var session = token; var since = boot; var last = cursor;
        watching = true;
        try
        {
            var result = await Task.Run(() => hub.Watch(session, since, last));
            if (result == null || Foreground || exiting || session != token || !alerts) return;
            var newBoot = Number(result, "boot");
            if (newBoot <= 0) return;
            if (boot != newBoot) { boot = newBoot; cursor = 0; StopRing(); }
            object items;
            if (!result.TryGetValue("events", out items) || !(items is IEnumerable)) return;
            foreach (var raw in (IEnumerable)items)
            {
                var item = raw as Dictionary<string, object>; if (item == null) continue;
                var sequence = Number(item, "seq"); if (sequence <= cursor) continue;
                cursor = sequence;
                var kind = TextValue(item, "kind"); var id = TextValue(item, "id");
                var name = TextValue(item, "name") ?? "Room member";
                if (name.Length > 24) name = name.Substring(0, 24);
                if (kind == "offer" && Flag(item, "live") && id != null && Regex.IsMatch(id, "^[a-f0-9-]{36}$"))
                {
                    incoming = id; StartRing();
                    tray.ShowBalloonTip(6000, name, TextValue(item, "mode") == "video" ? "Incoming video call" : "Incoming voice call", ToolTipIcon.Info);
                }
                else if (kind == "end" && id == incoming) StopRing();
                else if ((kind == "text" || kind == "photo") && !Flag(item, "mine"))
                    tray.ShowBalloonTip(4500, name, kind == "photo" ? "New photo" : "New message", ToolTipIcon.Info);
            }
        }
        catch (WebException) { }
        catch (IOException) { }
        catch (InvalidOperationException) { }
        catch (ArgumentException) { }
        finally { watching = false; }
    }

    private void StartRing()
    {
        if (ringtone.Enabled) return;
        ringUntil = DateTime.UtcNow.AddSeconds(47); SystemSounds.Exclamation.Play(); ringtone.Start();
    }
    private void StopRing() { ringtone.Stop(); incoming = ""; }
    private void Reveal() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    private void ExitWindow(int code) { exiting = true; Environment.ExitCode = code; Close(); }
    private void TraceCheck(string message)
    {
        if (verify) File.AppendAllText(Path.Combine(data, "verification.log"), message + Environment.NewLine);
    }

    private static string TextValue(Dictionary<string, object> item, string key)
    { object value; return item.TryGetValue(key, out value) ? value as string : null; }
    private static bool Flag(Dictionary<string, object> item, string key)
    { object value; return item.TryGetValue(key, out value) && value is bool && (bool)value; }
    private static long Number(Dictionary<string, object> item, string key)
    {
        object value;
        if (!item.TryGetValue(key, out value)) return 0;
        long number = value is int ? (int)value : value is long ? (long)value : 0;
        return number >= 0 && number <= uint.MaxValue ? number : 0;
    }
}
