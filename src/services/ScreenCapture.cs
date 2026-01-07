using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using System.IO;

namespace ScreenCaptureTool {
    class Program {
        static void Main(string[] args) {
            try {
                int targetWidth = 960;
                int targetHeight = 540;
                if (args.Length >= 2) {
                    int.TryParse(args[0], out targetWidth);
                    int.TryParse(args[1], out targetHeight);
                }

                Rectangle bounds = Screen.PrimaryScreen.Bounds;
                using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height)) {
                    using (Graphics g = Graphics.FromImage(bitmap)) {
                        g.CopyFromScreen(Point.Empty, Point.Empty, bounds.Size);
                    }

                    using (Bitmap resized = new Bitmap(targetWidth, targetHeight)) {
                        using (Graphics g = Graphics.FromImage(resized)) {
                            // Low interpolation for speed in streaming
                            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Low;
                            g.DrawImage(bitmap, 0, 0, targetWidth, targetHeight);
                        }

                        using (MemoryStream ms = new MemoryStream()) {
                            ImageCodecInfo jpegCodec = GetEncoder(ImageFormat.Jpeg);
                            EncoderParameters encoderParams = new EncoderParameters(1);
                            encoderParams.Param[0] = new EncoderParameter(Encoder.Quality, 50L);
                            resized.Save(ms, jpegCodec, encoderParams);
                            byte[] byteImage = ms.ToArray();
                            Console.Write(Convert.ToBase64String(byteImage));
                        }
                    }
                }
            } catch (Exception ex) {
                Console.Error.WriteLine(ex.Message);
                Environment.Exit(1);
            }
        }

        private static ImageCodecInfo GetEncoder(ImageFormat format) {
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
            foreach (ImageCodecInfo codec in codecs) {
                if (codec.FormatID == format.Guid) {
                    return codec;
                }
            }
            return null;
        }
    }
}
