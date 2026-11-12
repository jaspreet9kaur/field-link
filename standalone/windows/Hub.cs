using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal sealed class HubResponse
{
    public int Status;
    public string Headers;
    public byte[] Content;
}

internal sealed class Hub
{
    private static readonly Regex TokenPattern = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private readonly byte[] fingerprint;
    private readonly string sessionFile;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 12 };
    public readonly Uri Origin;

    public Hub(string address, string pin, string directory)
    {
        Origin = new Uri(address, UriKind.Absolute);
        if (Origin.Scheme != Uri.UriSchemeHttps || !Origin.IsDefaultPort || Origin.AbsolutePath != "/" ||
            Origin.UserInfo.Length != 0 || Origin.Query.Length != 0 || Origin.Fragment.Length != 0 || !TokenPattern.IsMatch(pin))
            throw new InvalidDataException("Invalid bundled hub configuration.");
        fingerprint = new byte[32];
        for (int i = 0; i < fingerprint.Length; i++) fingerprint[i] = Convert.ToByte(pin.Substring(i * 2, 2), 16);
        sessionFile = Path.Combine(directory, "session.bin");
    }

    public bool Owns(string address)
    {
        Uri target;
        return Uri.TryCreate(address, UriKind.Absolute, out target) && target.Scheme == Uri.UriSchemeHttps &&
            target.IdnHost == Origin.IdnHost && target.Port == Origin.Port && target.UserInfo.Length == 0;
    }

    public bool Matches(X509Certificate certificate)
    {
        if (certificate == null) return false;
        try
        {
            using (var leaf = new X509Certificate2(certificate))
            using (var sha = SHA256.Create())
            {
                var now = DateTime.UtcNow;
                if (now < leaf.NotBefore.ToUniversalTime() || now > leaf.NotAfter.ToUniversalTime()) return false;
                var actual = sha.ComputeHash(leaf.RawData);
                int diff = 0;
                for (int i = 0; i < fingerprint.Length; i++) diff |= fingerprint[i] ^ actual[i];
                return diff == 0;
            }
        }
        catch (CryptographicException) { return false; }
    }

    public static bool IsToken(string token) { return token != null && TokenPattern.IsMatch(token); }

    public bool Allows(string address, string method)
    {
        if (!Owns(address)) return false;
        var uri = new Uri(address);
        if (method == "GET")
        {
            if (uri.AbsolutePath == "/photo") return Regex.IsMatch(uri.Query, "^\\?id=[a-f0-9]{24}$");
            return uri.Query.Length == 0 && (uri.AbsolutePath == "/" || uri.AbsolutePath == "/app.js" ||
                uri.AbsolutePath == "/style.css" || uri.AbsolutePath == "/version");
        }
        return method == "POST" && uri.Query.Length == 0 && (uri.AbsolutePath == "/api" || uri.AbsolutePath == "/photo");
    }

    public string LoadSession()
    {
        try
        {
            var info = new FileInfo(sessionFile);
            if (!info.Exists || info.Length > 4096) return "";
            var clear = ProtectedData.Unprotect(File.ReadAllBytes(sessionFile), fingerprint, DataProtectionScope.CurrentUser);
            try { var token = Encoding.ASCII.GetString(clear); return IsToken(token) ? token : ""; }
            finally { Array.Clear(clear, 0, clear.Length); }
        }
        catch (IOException) { return ""; }
        catch (CryptographicException) { return ""; }
        catch (UnauthorizedAccessException) { return ""; }
    }

    public void SaveSession(string token)
    {
        if (token.Length == 0) { File.Delete(sessionFile); return; }
        var clear = Encoding.ASCII.GetBytes(token);
        try
        {
            var encrypted = ProtectedData.Protect(clear, fingerprint, DataProtectionScope.CurrentUser);
            var pending = sessionFile + ".new";
            File.WriteAllBytes(pending, encrypted);
            if (File.Exists(sessionFile)) File.Replace(pending, sessionFile, null);
            else File.Move(pending, sessionFile);
        }
        finally { Array.Clear(clear, 0, clear.Length); }
    }

    public HubResponse Fetch(string address, string method, string contentType, string token, string recipient, byte[] bytes)
    {
        if (!Allows(address, method)) throw new InvalidDataException("Unsupported hub request.");
        var uri = new Uri(address);
        var request = (HttpWebRequest)WebRequest.Create(uri);
        request.Proxy = null;
        request.AllowAutoRedirect = false;
        request.Method = method;
        request.ServicePoint.Expect100Continue = false;
        if (IsToken(token)) request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
        request.Timeout = request.ReadWriteTimeout = 5000;
        request.ServerCertificateValidationCallback = (sender, certificate, chain, errors) =>
            (errors == SslPolicyErrors.None || errors == SslPolicyErrors.RemoteCertificateChainErrors) && Matches(certificate);
        if (method == "POST")
        {
            var isPhoto = uri.AbsolutePath == "/photo";
            if (bytes == null || bytes.Length > (isPhoto ? 102400 : 10500) || contentType != (isPhoto ? "image/jpeg" : "application/json"))
                throw new InvalidDataException("Invalid hub request body.");
            request.ContentType = contentType;
            request.Headers["Origin"] = Origin.GetLeftPart(UriPartial.Authority);
            if (isPhoto && recipient != null && Regex.IsMatch(recipient, "^[a-f0-9]{16}$")) request.Headers["X-Recipient"] = recipient;
            request.ContentLength = bytes.Length;
            using (var output = request.GetRequestStream()) output.Write(bytes, 0, bytes.Length);
        }
        HttpWebResponse reply;
        try { reply = (HttpWebResponse)request.GetResponse(); }
        catch (WebException e) { reply = e.Response as HttpWebResponse; if (reply == null) throw; }
        using (var response = reply)
        using (var input = response.GetResponseStream())
        {
            int code = (int)response.StatusCode;
            if (code >= 300 && code < 400) throw new InvalidDataException("Unexpected hub redirect.");
            var headers = new StringBuilder();
            foreach (var name in new[] { "Content-Type", "Cache-Control", "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy" })
            {
                var value = response.Headers[name];
                if (!string.IsNullOrEmpty(value) && value.IndexOfAny(new[] {'\r', '\n'}) < 0) headers.Append(name).Append(": ").Append(value).Append("\r\n");
            }
            return new HubResponse { Status = code, Headers = headers.ToString(), Content = ReadBounded(input, 131072) };
        }
    }

    public static byte[] ReadBounded(Stream input, int limit)
    {
        if (input == null) return new byte[0];
        using (var data = new MemoryStream())
        {
            var buffer = new byte[4096]; int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
            {
                if (data.Length + count > limit) throw new InvalidDataException("Oversized hub payload.");
                data.Write(buffer, 0, count);
            }
            return data.ToArray();
        }
    }

    public Dictionary<string, object> Watch(string token, long boot, long cursor)
    {
        var body = Encoding.UTF8.GetBytes(json.Serialize(new { action = "watch", boot = boot, cursor = cursor }));
        var result = Fetch(new Uri(Origin, "/api").AbsoluteUri, "POST", "application/json", token, null, body);
        if (result.Status != 200 || result.Content.Length > 8192) return null;
        return json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(result.Content));
    }
}
