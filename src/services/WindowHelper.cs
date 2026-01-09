using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;

public class WindowHelper {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);

    private const int SW_MAXIMIZE = 3;
    private const int SW_MINIMIZE = 6;
    private const int MOUSEEVENTF_LEFTDOWN = 0x02;
    private const int MOUSEEVENTF_LEFTUP = 0x04;

    public static void Main(string[] args) {
        if (args.Length < 2) return;

        try {
            string command = args[0].ToLower();
            int pid = int.Parse(args[1]);
            
            Process p = Process.GetProcessById(pid);
            IntPtr handle = p.MainWindowHandle;
            if (handle == IntPtr.Zero) return;

            if (command == "maximize") {
                ShowWindow(handle, SW_MAXIMIZE);
            } 
            else if (command == "rotate") {
                // Rotation sequence
                ShowWindow(handle, SW_MINIMIZE);
                Thread.Sleep(250);
                ShowWindow(handle, SW_MAXIMIZE);
                SwitchToThisWindow(handle, true);
                
                if (args.Length >= 4) {
                    Thread.Sleep(1000); // Wait for window to settle
                    int x = int.Parse(args[2]);
                    int y = int.Parse(args[3]);
                    SetCursorPos(x, y);
                    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                }
            }
        } catch {
            // Silently fail to avoid blocking
        }
    }
}
