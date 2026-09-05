using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

namespace FerchiiLauncher
{
    public class MainForm : Form
    {
        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

        [DllImport("gdi32.dll", EntryPoint = "CreateRoundRectRgn")]
        public static extern IntPtr CreateRoundRectRgn(
            int nLeftRect,
            int nTopRect,
            int nRightRect,
            int nBottomRect,
            int nWidthEllipse,
            int nHeightEllipse
        );

        [DllImport("dwmapi.dll")]
        public static extern int DwmExtendFrameIntoClientArea(IntPtr hWnd, ref MARGINS pMarInset);

        [StructLayout(LayoutKind.Sequential)]
        public struct MARGINS
        {
            public int cxLeftWidth;
            public int cxRightWidth;
            public int cyTopHeight;
            public int cyBottomHeight;
        }

        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HT_CAPTION = 0x2;

        private Process serverProcess;
        private WebView2 webView;

        public MainForm()
        {
            this.Text = "FERCHII LAUNCHER - Minecraft Java Edition";
            this.FormBorderStyle = FormBorderStyle.None; // Quita la barra blanca superior
            this.DoubleBuffered = true;
            this.Size = new Size(1160, 750);
            this.MinimumSize = new Size(960, 620);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(10, 14, 24);

            ApplyWindowRounding();

            StartBackendServer();
            InitWebView();
        }

        private void ApplyWindowRounding()
        {
            try
            {
                // Bordes circulares redondeados en la ventana nativa
                this.Region = Region.FromHrgn(CreateRoundRectRgn(0, 0, this.Width, this.Height, 26, 26));

                // Extender marco DWM para soporte de translúcido y efectos glass
                MARGINS margins = new MARGINS { cxLeftWidth = -1, cxRightWidth = -1, cyTopHeight = -1, cyBottomHeight = -1 };
                DwmExtendFrameIntoClientArea(this.Handle, ref margins);
            }
            catch { }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            ApplyWindowRounding();
        }

        private void StartBackendServer()
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string nodeExe = Path.Combine(baseDir, "bin", "node.exe");
                string serverJs = Path.Combine(baseDir, "src", "server.js");

                if (!File.Exists(nodeExe))
                {
                    string binDir = Path.Combine(baseDir, "bin");
                    if (!Directory.Exists(binDir)) Directory.CreateDirectory(binDir);
                    using (WebClient client = new WebClient())
                    {
                        client.DownloadFile("https://nodejs.org/dist/v20.18.0/win-x64/node.exe", nodeExe);
                    }
                }

                // Iniciar servidor Node silenciosamente en segundo plano sin ventana
                ProcessStartInfo srv = new ProcessStartInfo();
                srv.FileName = nodeExe;
                srv.Arguments = "\"" + serverJs + "\"";
                srv.WorkingDirectory = baseDir;
                srv.CreateNoWindow = true;
                srv.UseShellExecute = false;
                serverProcess = Process.Start(srv);

                // Esperar a que el servidor HTTP local responda
                string targetUrl = "http://127.0.0.1:38491";
                for (int i = 0; i < 25; i++)
                {
                    try
                    {
                        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(targetUrl + "/api/status");
                        req.Timeout = 300;
                        using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                        {
                            if (res.StatusCode == HttpStatusCode.OK) break;
                        }
                    }
                    catch
                    {
                        Thread.Sleep(150);
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Fallo al iniciar el servidor interno del launcher:\n" + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async void InitWebView()
        {
            try
            {
                webView = new WebView2();
                webView.Dock = DockStyle.Fill;
                this.Controls.Add(webView);

                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string userDataDir = Path.Combine(localAppData, "FerchiiLauncherData");

                var env = await CoreWebView2Environment.CreateAsync(null, userDataDir);
                await webView.EnsureCoreWebView2Async(env);

                // Fondo transparente para permitir ver la GUI translúcida glass
                webView.DefaultBackgroundColor = Color.Transparent;

                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;

                // Manejo de mensajes desde el frontend JS (minimizar, maximizar, cerrar, arrastrar)
                webView.CoreWebView2.WebMessageReceived += (s, args) =>
                {
                    try
                    {
                        string msg = args.TryGetWebMessageAsString();
                        if (msg == "minimize")
                        {
                            this.WindowState = FormWindowState.Minimized;
                        }
                        else if (msg == "maximize")
                        {
                            this.WindowState = (this.WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized);
                            ApplyWindowRounding();
                        }
                        else if (msg == "close")
                        {
                            this.Close();
                        }
                        else if (msg == "drag")
                        {
                            ReleaseCapture();
                            SendMessage(this.Handle, WM_NCLBUTTONDOWN, HT_CAPTION, 0);
                        }
                        else if (msg != null && msg.StartsWith("openUrl:"))
                        {
                            // Abrir URL en el navegador del sistema (no en WebView2)
                            string url = msg.Substring("openUrl:".Length);
                            try
                            {
                                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                            }
                            catch { }
                        }
                    }
                    catch { }
                };

                webView.Source = new Uri("http://127.0.0.1:38491");
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error al inicializar la interfaz translúcida:\n" + ex.Message, "Error de Renderizado", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (serverProcess != null && !serverProcess.HasExited)
            {
                try
                {
                    serverProcess.Kill();
                }
                catch { }
            }
        }

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
