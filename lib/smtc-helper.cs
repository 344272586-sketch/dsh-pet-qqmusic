// dsh-pet-qqmusic 的 SMTC 读取器（Windows 10/11）。
//
// 为什么需要独立进程：Node 没有访问 Windows Runtime 的能力，而 QQ 音乐只通过
// SMTC（System Media Transport Controls）向系统暴露「歌名 / 歌手 / 播放进度」。
// 这个 helper 用 .NET Framework 的 WinRT 投影读取 SMTC，按行输出 JSON 给宿主。
//
// 编译（x64 .NET Framework，Windows 自带 csc）：
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe ^
//     /out:lib\smtc-helper.exe ^
//     /r:System.Runtime.dll ^
//     /r:System.Runtime.WindowsRuntime.dll ^
//     /r:C:\Windows\System32\WinMetadata\Windows.Foundation.winmd ^
//     /r:C:\Windows\System32\WinMetadata\Windows.Media.winmd ^
//     /r:C:\Windows\System32\WinMetadata\Windows.Storage.winmd ^
//     lib\smtc-helper.cs
//
// 输出（每行一个 JSON）：
//   {"ok":true,"ts":...,"intervalMs":400,"session":null,"count":0}
//   {"ok":true,"ts":...,"intervalMs":400,"session":{"source":"...","title":"...","artist":"...",
//     "album":"...","status":"Playing","playing":true,"positionMs":12345,
//     "durationMs":229000,"lastUpdatedMs":...},"count":1}
//
// 约定：
// - 只认 SourceAppUserModelId 含 "QQMusic" 的会话（大小写不敏感），不抢其它播放器。
// - position 是采样值；宿主按 (now - lastUpdatedMs) 外推，这里只给原始快照。
// - 没有会话时 session=null，宿主据此提示「QQ 音乐没开 SMTC / 没在播放」。

using System;
using System.Globalization;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;

internal static class Program
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static int intervalMs = 400;
    private static bool allowAny = false;

    private static void Log(string line)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }

    private static T Wait<T>(IAsyncOperation<T> op)
    {
        while (op.Status == AsyncStatus.Started) Thread.Sleep(15);
        if (op.Status != AsyncStatus.Completed)
            throw new Exception("WinRT async " + op.Status + (op.ErrorCode != null ? " " + op.ErrorCode.Message : ""));
        return op.GetResults();
    }

    private static string Esc(string s)
    {
        if (s == null) return "";
        var b = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '\\': b.Append("\\\\"); break;
                case '"': b.Append("\\\""); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                    else b.Append(c);
                    break;
            }
        }
        return b.ToString();
    }

    private static long UnixMs(DateTimeOffset t)
    {
        return t.ToUnixTimeMilliseconds();
    }

    private static string BuildSnapshot(GlobalSystemMediaTransportControlsSessionManager mgr)
    {
        var sessions = mgr.GetSessions();
        var sb = new StringBuilder(512);
        sb.Append("{\"ok\":true,\"ts\":").Append(UnixMs(DateTimeOffset.Now));
        sb.Append(",\"intervalMs\":").Append(intervalMs);
        sb.Append(",\"count\":").Append(sessions.Count);
        sb.Append(",\"session\":");
        GlobalSystemMediaTransportControlsSession picked = null;
        foreach (var s in sessions)
        {
            try
            {
                string src = s.SourceAppUserModelId ?? "";
                bool isQQ = src.IndexOf("QQMusic", StringComparison.OrdinalIgnoreCase) >= 0;
                bool isNetease = src.IndexOf("cloudmusic", StringComparison.OrdinalIgnoreCase) >= 0
                    || src.IndexOf("netease", StringComparison.OrdinalIgnoreCase) >= 0
                    || src.IndexOf("com.netease", StringComparison.OrdinalIgnoreCase) >= 0;
                if (isQQ || isNetease)
                {
                    picked = s;
                    break;
                }
                // 调试模式：没有目标播放器时也读一个会话（--any），只用于自检
                if (allowAny && picked == null) picked = s;
            }
            catch { }
        }
        if (picked == null)
        {
            sb.Append("null}");
            return sb.ToString();
        }
        try
        {
            var props = Wait(picked.TryGetMediaPropertiesAsync());
            var timeline = picked.GetTimelineProperties();
            var info = picked.GetPlaybackInfo();
            double pos = timeline.Position.TotalMilliseconds;
            double start = timeline.StartTime.TotalMilliseconds;
            double end = timeline.EndTime.TotalMilliseconds;
            double duration = end > start ? end - start : 0;
            if (duration <= 0 && end > 0) duration = end;
            // QQ 音乐在部分版本会给出 NaN / 空 PlaybackRate；直接拼进 JSON 会得到
            // "playbackRate":}（非法 JSON），宿主就永远读不到会话。这里统一兜底。
            if (double.IsNaN(pos) || double.IsInfinity(pos) || pos < 0) pos = 0;
            if (double.IsNaN(duration) || double.IsInfinity(duration) || duration < 0) duration = 0;
            double rate = 1;
            try { rate = Convert.ToDouble(info.PlaybackRate, CultureInfo.InvariantCulture); }
            catch { rate = 1; }
            if (double.IsNaN(rate) || double.IsInfinity(rate)) rate = 1;
            bool playing = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
            sb.Append("{\"source\":\"").Append(Esc(picked.SourceAppUserModelId));
            bool pickedQQ = (picked.SourceAppUserModelId ?? "").IndexOf("QQMusic", StringComparison.OrdinalIgnoreCase) >= 0;
            sb.Append("\",\"player\":\"").Append(pickedQQ ? "qq" : "netease").Append("\"");
            sb.Append(",\"title\":\"").Append(Esc(props.Title));
            sb.Append("\",\"artist\":\"").Append(Esc(props.Artist));
            sb.Append("\",\"album\":\"").Append(Esc(props.AlbumTitle));
            sb.Append("\",\"status\":\"").Append(info.PlaybackStatus.ToString());
            sb.Append("\",\"playing\":").Append(playing ? "true" : "false");
            sb.Append(",\"positionMs\":").Append(Math.Round(pos));
            sb.Append(",\"durationMs\":").Append(Math.Round(duration));
            sb.Append(",\"lastUpdatedMs\":").Append(UnixMs(timeline.LastUpdatedTime));
            sb.Append(",\"playbackRate\":").Append(rate.ToString("0.###", CultureInfo.InvariantCulture));
            sb.Append("}}");
        }
        catch (Exception e)
        {
            sb.Append("null,\"error\":\"").Append(Esc(e.Message)).Append("\"}");
        }
        return sb.ToString();
    }

    private static void Main(string[] args)
    {
        Console.OutputEncoding = Utf8;
        bool watch = false;
        bool any = false;
        foreach (var arg in args)
        {
            if (arg == "--watch" || arg == "-w") watch = true;
            else if (arg == "--any") any = true;
            else if (arg.StartsWith("--interval=", StringComparison.Ordinal))
            {
                int v;
                if (int.TryParse(arg.Substring("--interval=".Length), out v) && v >= 100 && v <= 5000) intervalMs = v;
            }
        }
        allowAny = any;

        GlobalSystemMediaTransportControlsSessionManager mgr = null;
        try
        {
            mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        }
        catch (Exception e)
        {
            Log("{\"ok\":false,\"ts\":" + UnixMs(DateTimeOffset.Now) + ",\"error\":\"" + Esc(e.Message) + "\"}");
            if (!watch) return;
        }

        if (!watch)
        {
            Log(mgr != null ? BuildSnapshot(mgr) : "{\"ok\":false,\"error\":\"no manager\"}");
            return;
        }

        string last = null;
        int idleTicks = 0;
        while (true)
        {
            try
            {
                if (mgr == null) mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
                string snap = BuildSnapshot(mgr);
                // 变化立即输出；无变化时 1 秒一次心跳，足够宿主外推进度，也不刷屏
                if (snap != last || snap.IndexOf("\"session\":null", StringComparison.Ordinal) < 0)
                {
                    Log(snap);
                    last = snap;
                    idleTicks = 0;
                }
                else
                {
                    idleTicks++;
                    if (idleTicks % 5 == 0) Log(snap); // 无会话：每 2 秒报一次
                }
            }
            catch (Exception e)
            {
                Log("{\"ok\":false,\"ts\":" + UnixMs(DateTimeOffset.Now) + ",\"error\":\"" + Esc(e.Message) + "\"}");
                mgr = null;
            }
            Thread.Sleep(intervalMs);
        }
    }
}
