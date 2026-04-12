#!/usr/bin/env python3
"""
Canela - backend.py
Camera & Microphone control for Cinnamon panel.
"""

import os
import sys
import json
import glob
import signal
import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst, GLib

Gst.init(None)


# ---------------------------------------------------------------------------
# Session detection
# ---------------------------------------------------------------------------

def detect_session():
    session = os.environ.get("XDG_SESSION_TYPE", "").lower()
    if session == "wayland":
        return "wayland"
    if os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    return "x11"


SESSION = detect_session()


def find_canela_cam():
    """Find the v4l2loopback device labelled 'Canela Cam'."""
    try:
        for path in sorted(glob.glob("/sys/class/video4linux/video*/name")):
            with open(path, "r") as f:
                name = f.read().strip()
                if "Canela Cam" in name:
                    dev = "/dev/" + path.split("/")[-2]
                    return dev
    except Exception as e:
        print(f"[Canela] find_canela_cam error: {e}", file=sys.stderr)
    return None


def get_camera_src():
    if SESSION == "wayland":
        return "pipewiresrc"
    return "v4l2src"


def get_mic_src():
    if SESSION == "wayland":
        return "pipewiresrc"
    return "pulsesrc"


# ---------------------------------------------------------------------------
# Camera pipeline
# ---------------------------------------------------------------------------

class CameraBackend:
    def __init__(self):
        self.pipeline = None
        self.running = False

    def build_pipeline(self, brightness=72, contrast=45, blur=20):
        src = get_camera_src()

        # Map 0-100 slider values to GStreamer ranges
        gamma_val = 0.01 + (brightness / 100.0) * 9.99
        contrast_val = -2.0 + (contrast / 100.0) * 4.0
        blur_radius = int((blur / 100.0) * 15)

        # The webcam emits MJPEG (image/jpeg), so we decode first
        pipeline_str = f"{src} ! jpegdec ! videoconvert ! "
        pipeline_str += f"gamma gamma={gamma_val:.2f} ! "
        pipeline_str += f"videobalance contrast={contrast_val:.2f} ! "

        if blur_radius > 0:
            pipeline_str += f"gaussianblur sigma={blur_radius} ! "

        dev = find_canela_cam()
        if dev:
            pipeline_str += f"videoconvert ! video/x-raw,format=YUY2 ! v4l2sink device={dev}"
        else:
            pipeline_str += "autovideosink"

        return pipeline_str

    def start(self, brightness=72, contrast=45, blur=20):
        self.stop()
        pipeline_str = self.build_pipeline(brightness, contrast, blur)
        print(f"[Canela] Starting camera: {pipeline_str}", file=sys.stderr)
        try:
            self.pipeline = Gst.parse_launch(pipeline_str)
            ret = self.pipeline.set_state(Gst.State.PLAYING)
            if ret == Gst.StateChangeReturn.FAILURE:
                raise RuntimeError("Pipeline failed to start")
            self.running = True
            print(f"[Canela] Camera started OK", file=sys.stderr)
        except Exception as e:
            print(f"[Canela] Camera pipeline error: {e}", file=sys.stderr)
            self.pipeline = None
            self.running = False
            print(json.dumps({"status": "pipeline_error", "source": "cam", "message": str(e)}), flush=True)

    def stop(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None
        self.running = False

    def update(self, **kwargs):
        self.start(**kwargs)


# ---------------------------------------------------------------------------
# Microphone pipeline
# ---------------------------------------------------------------------------

class MicBackend:
    def __init__(self):
        self.pipeline = None
        self.running = False

    def build_pipeline(self, gain=65, reverb=30, noise_reduction=40, mic_range=50):
        src = get_mic_src()

        gain_val = (gain / 100.0) * 2.0

        # noisegate is optional — skip if not available
        noise_element = ""
        if noise_reduction > 0:
            threshold = -60 + (noise_reduction / 100.0) * 50
            noise_element = f"noisegate threshold={threshold:.1f} ! "

        pipeline_str = (
            f"{src} ! audioconvert ! audioresample ! "
            f"volume volume={gain_val:.2f} ! "
            f"{noise_element}"
            f"pulsesink device=CanelaSink"
        )

        return pipeline_str

    def start(self, gain=65, reverb=30, noise_reduction=40, mic_range=50):
        self.stop()
        pipeline_str = self.build_pipeline(gain, reverb, noise_reduction, mic_range)
        print(f"[Canela] Starting mic: {pipeline_str}", file=sys.stderr)
        try:
            self.pipeline = Gst.parse_launch(pipeline_str)
            ret = self.pipeline.set_state(Gst.State.PLAYING)
            if ret == Gst.StateChangeReturn.FAILURE:
                # Try without noisegate as fallback
                raise RuntimeError("Pipeline failed, trying without noisegate")
            self.running = True
        except Exception as e:
            print(f"[Canela] Mic pipeline error: {e}, retrying without noisegate", file=sys.stderr)
            try:
                src = get_mic_src()
                gain_val = (gain / 100.0) * 2.0
                simple = f"{src} ! audioconvert ! audioresample ! volume volume={gain_val:.2f} ! pulsesink device=CanelaSink"
                self.pipeline = Gst.parse_launch(simple)
                self.pipeline.set_state(Gst.State.PLAYING)
                self.running = True
            except Exception as e2:
                print(f"[Canela] Mic fallback error: {e2}", file=sys.stderr)
                self.pipeline = None
                self.running = False

    def stop(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None
        self.running = False

    def update(self, **kwargs):
        self.start(**kwargs)


# ---------------------------------------------------------------------------
# Hardware monitor
# ---------------------------------------------------------------------------

class HardwareMonitor:
    def __init__(self, callback):
        self.callback = callback
        self.monitor = Gst.DeviceMonitor.new()
        self.monitor.add_filter("Video/Source", None)
        self.monitor.add_filter("Audio/Source", None)

        bus = self.monitor.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_message)

    def start(self):
        self.monitor.start()
        self.check_now()

    def stop(self):
        self.monitor.stop()

    def check_now(self):
        devices = self.monitor.get_devices()
        has_cam = False
        has_mic = False

        for d in devices:
            dev_class = d.get_device_class()
            if "Video/Source" in dev_class:
                has_cam = True
            if "Audio/Source" in dev_class:
                has_mic = True

        print(f"[Canela] HW check: cam={has_cam}, mic={has_mic}", file=sys.stderr)
        self.callback(has_cam, has_mic)

    def _on_message(self, bus, msg):
        if msg.type in (Gst.MessageType.DEVICE_ADDED, Gst.MessageType.DEVICE_REMOVED):
            self.check_now()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    cam = CameraBackend()
    mic = MicBackend()
    loop = GLib.MainLoop()

    def report_hw(has_cam, has_mic):
        if not has_cam and cam.running:
            cam.stop()
        if not has_mic and mic.running:
            mic.stop()
        print(json.dumps({
            "action": "hw_status",
            "cam": has_cam,
            "mic": has_mic
        }), flush=True)

    hw = HardwareMonitor(report_hw)

    def handle_message(message):
        try:
            msg = json.loads(message)
            action = msg.get("action")

            if action == "hw_check":
                hw.check_now()
            elif action == "cam_start":
                import glob
                if glob.glob("/sys/class/video4linux/video*/name"):
                    cam.start(brightness=msg.get("brightness", 72), contrast=msg.get("contrast", 45), blur=msg.get("blur", 20))
            elif action == "cam_stop":
                cam.stop()
            elif action == "cam_update":
                import glob
                if glob.glob("/sys/class/video4linux/video*/name"):
                    cam.update(brightness=msg.get("brightness", 72), contrast=msg.get("contrast", 45), blur=msg.get("blur", 20))
            elif action == "mic_start" or action == "mic_update":
                import subprocess
                res = subprocess.run(["pactl", "list", "sinks", "short"], capture_output=True, text=True)
                if "CanelaSink" not in res.stdout:
                    subprocess.run(["pactl", "load-module", "module-null-sink", "sink_name=CanelaSink", 'sink_properties=device.description="Canela Mic"'])
                if action == "mic_start":
                    mic.start(gain=msg.get("gain", 65), reverb=msg.get("reverb", 30), noise_reduction=msg.get("noise_reduction", 40), mic_range=msg.get("mic_range", 50))
                else:
                    mic.update(gain=msg.get("gain", 65), reverb=msg.get("reverb", 30), noise_reduction=msg.get("noise_reduction", 40), mic_range=msg.get("mic_range", 50))
            elif action == "mic_stop":
                mic.stop()
            elif action == "quit":
                cam.stop()
                mic.stop()
                loop.quit()

            if action != "quit":
                print(json.dumps({"session": SESSION, "status": "ok", "action": action}), flush=True)

        except Exception as e:
            print(json.dumps({"status": "error", "message": str(e)}), flush=True)

    def on_stdin(source, condition):
        line = source.readline()
        if line:
            handle_message(line.strip())
            return True
        return False

    GLib.io_add_watch(sys.stdin, GLib.IOCondition.IN, on_stdin)
    signal.signal(signal.SIGTERM, lambda *_: loop.quit())

    hw.start()
    print(json.dumps({"status": "ready", "session": SESSION}), flush=True)
    loop.run()
    hw.stop()


if __name__ == "__main__":
    main()
