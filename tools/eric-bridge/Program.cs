using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal sealed record BridgeRequest(
    string RuntimeDirectory,
    string LogDirectory,
    string XmlPath,
    string ResultPath,
    string ServerResponsePath,
    bool Send,
    string? CertificatePath,
    string? Pin);

internal sealed record BridgeResponse(int StatusCode, string StatusText, bool Sent);

internal static class Program
{
    private const uint Validate = 1u << 1;
    private const uint Send = 1u << 2;

    public static int Main()
    {
        uint certificateHandle = 0;
        var initialized = false;
        try
        {
            var request = JsonSerializer.Deserialize<BridgeRequest>(Console.In.ReadToEnd(), JsonOptions())
                ?? throw new InvalidOperationException("Die Bridge-Anfrage fehlt.");
            ValidateRequest(request);
            Directory.CreateDirectory(request.LogDirectory);
            if (!Native.SetDllDirectory(request.RuntimeDirectory))
                throw new InvalidOperationException("Das ERiC-Runtimeverzeichnis konnte nicht gesetzt werden.");

            var status = Native.EricInitialisiere(request.RuntimeDirectory, request.LogDirectory);
            initialized = status == 0;
            EnsureSuccess(status, "ERiC initialisieren");

            IntPtr cryptoPointer = IntPtr.Zero;
            IntPtr pinPointer = IntPtr.Zero;
            try
            {
                if (request.Send)
                {
                    status = Native.EricGetHandleToCertificate(out certificateHandle, out _, request.CertificatePath!);
                    EnsureSuccess(status, "ELSTER-Zertifikat öffnen");
                    pinPointer = Utf8.Allocate(request.Pin!);
                    var crypto = new EncryptionParameters { Version = 3, CertificateHandle = certificateHandle, Pin = pinPointer };
                    cryptoPointer = Marshal.AllocHGlobal(Marshal.SizeOf<EncryptionParameters>());
                    Marshal.StructureToPtr(crypto, cryptoPointer, false);
                }

                var xml = File.ReadAllText(request.XmlPath, Encoding.UTF8);
                using var xmlPointer = new Utf8(xml);
                using var versionPointer = new Utf8("Bilanz_6.9");
                using var result = new ReturnBuffer();
                using var serverResponse = new ReturnBuffer();
                var flags = Validate | (request.Send ? Send : 0);
                status = Native.EricBearbeiteVorgang(
                    xmlPointer.Pointer, versionPointer.Pointer, flags, IntPtr.Zero, cryptoPointer,
                    result.Handle, serverResponse.Handle);
                File.WriteAllText(request.ResultPath, result.Content, new UTF8Encoding(false));
                File.WriteAllText(request.ServerResponsePath, serverResponse.Content, new UTF8Encoding(false));
                var response = new BridgeResponse(status, ErrorText(status), request.Send && status == 0);
                Console.Out.Write(JsonSerializer.Serialize(response, JsonOptions()));
                return status == 0 ? 0 : 2;
            }
            finally
            {
                if (cryptoPointer != IntPtr.Zero) Marshal.FreeHGlobal(cryptoPointer);
                if (pinPointer != IntPtr.Zero) Marshal.FreeHGlobal(pinPointer);
                if (certificateHandle != 0) Native.EricCloseHandleToCertificate(certificateHandle);
            }
        }
        catch (Exception error)
        {
            Console.Out.Write(JsonSerializer.Serialize(new { statusCode = -1, statusText = error.Message, sent = false }, JsonOptions()));
            return 1;
        }
        finally
        {
            if (initialized) Native.EricBeende();
        }
    }

    private static void ValidateRequest(BridgeRequest request)
    {
        if (!File.Exists(Path.Combine(request.RuntimeDirectory, "ericapi.dll")))
            throw new InvalidOperationException("ericapi.dll wurde im Runtimeverzeichnis nicht gefunden.");
        if (!File.Exists(Path.Combine(request.RuntimeDirectory, "plugins", "checkBilanz_6_9.dll")))
            throw new InvalidOperationException("Das ERiC-Prüfplugin für Bilanz 6.9 fehlt.");
        if (!File.Exists(request.XmlPath)) throw new InvalidOperationException("Der ELSTER-XML-Datensatz fehlt.");
        if (new FileInfo(request.XmlPath).Length > 60L * 1024 * 1024)
            throw new InvalidOperationException("Der ELSTER-XML-Datensatz überschreitet 60 MiB.");
        if (request.Send && (string.IsNullOrWhiteSpace(request.CertificatePath) || !File.Exists(request.CertificatePath)))
            throw new InvalidOperationException("Für die Übermittlung ist eine Zertifikatsdatei erforderlich.");
        if (request.Send && string.IsNullOrEmpty(request.Pin))
            throw new InvalidOperationException("Für die Übermittlung ist die Zertifikats-PIN erforderlich.");
    }

    private static string ErrorText(int status)
    {
        if (status == 0) return "Verarbeitung fehlerfrei.";
        using var buffer = new ReturnBuffer();
        return Native.EricHoleFehlerText(status, buffer.Handle) == 0 ? buffer.Content : $"ERiC-Fehler {status}";
    }

    private static void EnsureSuccess(int status, string action)
    {
        if (status != 0) throw new InvalidOperationException($"{action}: {ErrorText(status)} ({status})");
    }

    private static JsonSerializerOptions JsonOptions() => new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}

[StructLayout(LayoutKind.Sequential)]
internal struct EncryptionParameters
{
    public uint Version;
    public uint CertificateHandle;
    public IntPtr Pin;
}

internal sealed class Utf8 : IDisposable
{
    public IntPtr Pointer { get; private set; }
    public Utf8(string value) => Pointer = Allocate(value);
    public static IntPtr Allocate(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        var pointer = Marshal.AllocHGlobal(bytes.Length + 1);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        Marshal.WriteByte(pointer, bytes.Length, 0);
        return pointer;
    }
    public void Dispose()
    {
        if (Pointer == IntPtr.Zero) return;
        Marshal.FreeHGlobal(Pointer);
        Pointer = IntPtr.Zero;
    }
}

internal sealed class ReturnBuffer : IDisposable
{
    public IntPtr Handle { get; private set; } = Native.EricRueckgabepufferErzeugen();
    public string Content
    {
        get
        {
            var length = Native.EricRueckgabepufferLaenge(Handle);
            return length <= 0 ? string.Empty : Marshal.PtrToStringUTF8(Native.EricRueckgabepufferInhalt(Handle), length) ?? string.Empty;
        }
    }
    public void Dispose()
    {
        if (Handle == IntPtr.Zero) return;
        Native.EricRueckgabepufferFreigeben(Handle);
        Handle = IntPtr.Zero;
    }
}

internal static partial class Native
{
    [LibraryImport("kernel32.dll", EntryPoint = "SetDllDirectoryW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetDllDirectory(string path);

    [DllImport("ericapi.dll", CharSet = CharSet.Ansi, ExactSpelling = true)]
    internal static extern int EricInitialisiere(string pluginPath, string logPath);
    [LibraryImport("ericapi.dll")] internal static partial int EricBeende();
    [DllImport("ericapi.dll", CharSet = CharSet.Ansi, ExactSpelling = true)]
    internal static extern int EricGetHandleToCertificate(out uint handle, out uint pinSupport, string path);
    [LibraryImport("ericapi.dll")] internal static partial int EricCloseHandleToCertificate(uint handle);
    [LibraryImport("ericapi.dll")] internal static partial IntPtr EricRueckgabepufferErzeugen();
    [LibraryImport("ericapi.dll")] internal static partial IntPtr EricRueckgabepufferInhalt(IntPtr handle);
    [LibraryImport("ericapi.dll")] internal static partial int EricRueckgabepufferLaenge(IntPtr handle);
    [LibraryImport("ericapi.dll")] internal static partial int EricRueckgabepufferFreigeben(IntPtr handle);
    [LibraryImport("ericapi.dll")] internal static partial int EricHoleFehlerText(int code, IntPtr buffer);
    [LibraryImport("ericapi.dll")]
    internal static partial int EricBearbeiteVorgang(
        IntPtr xml, IntPtr datenartVersion, uint flags, IntPtr printParameters,
        IntPtr encryptionParameters, IntPtr resultBuffer, IntPtr serverResponseBuffer);
}
