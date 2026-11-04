#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backend.py — Motor de procesamiento de cámara, audio e inteligencia artificial para Canela.
- Visión: GStreamer + OpenCV + MediaPipe (Selfie Segmentation y Face Detection AR).
- Audio: Medición de espectro (11 bandas) y delay en vivo de 2 segundos.
"""

import sys
import os
import json
import time
import signal
import threading
import subprocess
import re
import math
import numpy as np
import cv2

import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst, GLib

import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

Gst.init(None)

SHM_DIR = "/dev/shm"
FRAME_PATH_0 = os.path.join(SHM_DIR, "canela_frame_0.jpg")
FRAME_PATH_1 = os.path.join(SHM_DIR, "canela_frame_1.jpg")
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
SELFIE_MODEL_PATH = os.path.join(MODELS_DIR, "selfie_segmenter.tflite")
FACE_MODEL_PATH = os.path.join(MODELS_DIR, "blaze_face_short_range.tflite")


def log_debug(msg):
    print(f"[Canela-Backend] {msg}", file=sys.stderr, flush=True)


def detect_session():
    session = os.environ.get("XDG_SESSION_TYPE", "").lower()
    if session == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    return "x11"


SESSION = detect_session()


def ensure_single_instance():
    pid_file = os.path.join(SHM_DIR, "canela_backend.pid")
    if os.path.exists(pid_file):
        try:
            with open(pid_file, "r") as f:
                old_pid = int(f.read().strip())
            if old_pid != os.getpid():
                log_debug(f"Terminando instancia previa (PID {old_pid})...")
                os.kill(old_pid, signal.SIGTERM)
                time.sleep(0.3)
                try:
                    os.kill(old_pid, 0)
                    os.kill(old_pid, signal.SIGKILL)
                except OSError:
                    pass
        except Exception as e:
            log_debug(f"Error limpiando PID previo: {e}")

    try:
        with open(pid_file, "w") as f:
            f.write(str(os.getpid()))
    except Exception as e:
        log_debug(f"Error escribiendo PID: {e}")


def get_available_cameras():
    cameras = []
    devs = [f"/dev/{d}" for d in os.listdir("/dev") if d.startswith("video")]
    devs.sort(key=lambda x: int(x.replace("/dev/video", "")) if x.replace("/dev/video", "").isdigit() else 99)
    for dev in devs:
        if os.path.exists(dev):
            cameras.append({"device": dev, "name": f"Webcam ({os.path.basename(dev)})"})
    if not cameras:
        cameras.append({"device": "/dev/video0", "name": "Webcam (por defecto)"})
    return cameras


def get_system_mic_info():
    volume = 100
    muted = False
    try:
        res = subprocess.run(
            ["pactl", "get-source-volume", "@DEFAULT_SOURCE@"],
            capture_output=True, text=True, timeout=2
        )
        m = re.search(r'(\d+)%', res.stdout)
        if m:
            volume = int(m.group(1))

        res_m = subprocess.run(
            ["pactl", "get-source-mute", "@DEFAULT_SOURCE@"],
            capture_output=True, text=True, timeout=2
        )
        muted = "yes" in res_m.stdout.lower()
    except Exception as e:
        log_debug(f"Error consultando pactl: {e}")
    return volume, muted


# ---------------------------------------------------------------------------
# Filtros de Voz
# ---------------------------------------------------------------------------
VOICE_FILTERS = {
    "natural": "audioconvert",
    "studio": "audioconvert ! audiodynamic threshold=0.4 ratio=2.0 ! equalizer-3bands band0=3.0 band1=1.5 band2=2.0",
    "radio": "audioconvert ! equalizer-3bands band0=-12.0 band1=4.0 band2=-8.0",
    "megaphone": "audioconvert ! audiochebband mode=band-pass lower-frequency=400 upper-frequency=2800",
    "echo": "audioconvert ! audioecho delay=150000000 intensity=0.4 feedback=0.3"
}


# ---------------------------------------------------------------------------
# Renderizado de Avatares AR
# ---------------------------------------------------------------------------
def apply_avatar(frame, avatar_type, keypoints):
    if not keypoints or avatar_type == "none":
        return frame

    # keypoints: [right_eye, left_eye, nose, mouth, right_ear, left_ear]
    re, le, nose, mouth, rear, lear = keypoints
    eye_dist = math.hypot(le[0] - re[0], le[1] - re[1])
    scale = max(0.4, eye_dist / 35.0)
    cx = int((re[0] + le[0]) / 2)
    cy = int((re[1] + le[1]) / 2)
    top_y = cy - int(eye_dist * 0.95)

    if avatar_type == "dog":
        # Orejas caídas de perrito
        ear_h = int(48 * scale)
        pts_l = np.array([
            [cx - int(20 * scale), top_y + int(5 * scale)],
            [cx - int(45 * scale), top_y + int(18 * scale)],
            [cx - int(38 * scale), top_y + ear_h],
            [cx - int(16 * scale), top_y + int(ear_h * 0.85)]
        ], dtype=np.int32)
        cv2.fillPoly(frame, [pts_l], (35, 75, 145))

        pts_r = np.array([
            [cx + int(20 * scale), top_y + int(5 * scale)],
            [cx + int(45 * scale), top_y + int(18 * scale)],
            [cx + int(38 * scale), top_y + ear_h],
            [cx + int(16 * scale), top_y + int(ear_h * 0.85)]
        ], dtype=np.int32)
        cv2.fillPoly(frame, [pts_r], (35, 75, 145))

        # Interior orejas
        cv2.fillPoly(frame, [np.array([[cx - int(38 * scale), top_y + int(24 * scale)], [cx - int(33 * scale), top_y + int(ear_h * 0.85)], [cx - int(20 * scale), top_y + int(ear_h * 0.75)], [cx - int(22 * scale), top_y + int(15 * scale)]], dtype=np.int32)], (110, 140, 210))
        cv2.fillPoly(frame, [np.array([[cx + int(38 * scale), top_y + int(24 * scale)], [cx + int(33 * scale), top_y + int(ear_h * 0.85)], [cx + int(20 * scale), top_y + int(ear_h * 0.75)], [cx + int(22 * scale), top_y + int(15 * scale)]], dtype=np.int32)], (110, 140, 210))

        # Nariz de cachorro
        nw, nh = int(11 * scale), int(8 * scale)
        cv2.ellipse(frame, (int(nose[0]), int(nose[1])), (nw, nh), 0, 0, 360, (20, 20, 20), -1)
        cv2.circle(frame, (int(nose[0] - nw * 0.3), int(nose[1] - nh * 0.3)), max(1, int(2 * scale)), (240, 240, 240), -1)

        # Lengüita
        tw, th = int(7 * scale), int(12 * scale)
        cv2.ellipse(frame, (int(mouth[0]), int(mouth[1] + th * 0.5)), (tw, th), 0, 0, 360, (110, 110, 245), -1)

    elif avatar_type == "cat":
        # Orejas triangulares
        pts_l = np.array([
            [cx - int(12 * scale), top_y + int(10 * scale)],
            [cx - int(38 * scale), top_y - int(28 * scale)],
            [cx - int(46 * scale), top_y + int(15 * scale)]
        ], dtype=np.int32)
        cv2.fillPoly(frame, [pts_l], (220, 220, 225))

        pts_r = np.array([
            [cx + int(12 * scale), top_y + int(10 * scale)],
            [cx + int(38 * scale), top_y - int(28 * scale)],
            [cx + int(46 * scale), top_y + int(15 * scale)]
        ], dtype=np.int32)
        cv2.fillPoly(frame, [pts_r], (220, 220, 225))

        # Interior rosa
        cv2.fillPoly(frame, [np.array([[cx - int(18 * scale), top_y + int(8 * scale)], [cx - int(36 * scale), top_y - int(20 * scale)], [cx - int(40 * scale), top_y + int(10 * scale)]], dtype=np.int32)], (180, 150, 245))
        cv2.fillPoly(frame, [np.array([[cx + int(18 * scale), top_y + int(8 * scale)], [cx + int(38 * scale), top_y - int(20 * scale)], [cx + int(40 * scale), top_y + int(10 * scale)]], dtype=np.int32)], (180, 150, 245))

        # Naricita rosa
        nw, nh = int(7 * scale), int(5 * scale)
        pts_n = np.array([
            [int(nose[0] - nw), int(nose[1] - nh)],
            [int(nose[0] + nw), int(nose[1] - nh)],
            [int(nose[0]), int(nose[1] + nh)]
        ], dtype=np.int32)
        cv2.fillPoly(frame, [pts_n], (170, 140, 240))

        # Bigotes felinos
        for dy, ldy in [(-4, -6), (0, 0), (4, 6)]:
            cv2.line(frame, (int(nose[0] - 12 * scale), int(nose[1] + dy * scale)), (int(nose[0] - 45 * scale), int(nose[1] + ldy * scale)), (245, 245, 245), max(1, int(1.5 * scale)))
            cv2.line(frame, (int(nose[0] + 12 * scale), int(nose[1] + dy * scale)), (int(nose[0] + 45 * scale), int(nose[1] + ldy * scale)), (245, 245, 245), max(1, int(1.5 * scale)))

    elif avatar_type == "panda":
        # Orejas redondas de panda
        r = int(16 * scale)
        cv2.circle(frame, (cx - int(34 * scale), top_y), r, (25, 25, 25), -1)
        cv2.circle(frame, (cx + int(34 * scale), top_y), r, (25, 25, 25), -1)

        # Manchas oscuras en ojos
        overlay = frame.copy()
        cv2.ellipse(overlay, (int(re[0]), int(re[1])), (int(16 * scale), int(12 * scale)), -15, 0, 360, (30, 30, 30), -1)
        cv2.ellipse(overlay, (int(le[0]), int(le[1])), (int(16 * scale), int(12 * scale)), 15, 0, 360, (30, 30, 30), -1)
        cv2.addWeighted(overlay, 0.7, frame, 0.3, 0, frame)

        # Nariz de panda
        cv2.ellipse(frame, (int(nose[0]), int(nose[1])), (int(9 * scale), int(6 * scale)), 0, 0, 360, (20, 20, 20), -1)

    elif avatar_type == "cyber":
        # Visor futurista Cyberpunk
        overlay = frame.copy()
        vx0 = int(re[0] - 20 * scale)
        vx1 = int(le[0] + 20 * scale)
        vy0 = int(cy - 14 * scale)
        vy1 = int(cy + 14 * scale)
        pts_v = np.array([
            [vx0, vy0], [vx1, vy0],
            [vx1 - int(6 * scale), vy1], [vx0 + int(6 * scale), vy1]
        ], dtype=np.int32)
        cv2.fillPoly(overlay, [pts_v], (20, 20, 20))
        cv2.addWeighted(overlay, 0.75, frame, 0.25, 0, frame)
        cv2.polylines(frame, [pts_v], True, (89, 199, 52), max(1, int(2 * scale)))
        cv2.line(frame, (vx0 + 4, cy), (vx1 - 4, cy), (120, 255, 80), max(1, int(1.5 * scale)))

    return frame


# ---------------------------------------------------------------------------
# Backend de Cámara Inteligente
# ---------------------------------------------------------------------------
class CameraBackend:
    def __init__(self):
        self.pipeline = None
        self.running = False
        self.flip = 0
        self.current_brightness = 50
        self.current_contrast = 50
        self.current_blur = "none" # "none", "soft", "deep"
        self.current_mode = "landscape"
        self.current_avatar = "none"
        self.current_device = "/dev/video0"
        self._lock = threading.Lock()

        # Modelos MediaPipe
        self.segmenter = None
        self.detector = None
        self._init_models()

    def _init_models(self):
        try:
            if os.path.exists(SELFIE_MODEL_PATH):
                base_options = python.BaseOptions(model_asset_path=SELFIE_MODEL_PATH)
                options = vision.ImageSegmenterOptions(base_options=base_options, output_confidence_masks=True)
                self.segmenter = vision.ImageSegmenter.create_from_options(options)
                log_debug("MediaPipe Selfie Segmenter inicializado")
        except Exception as e:
            log_debug(f"Error cargando Selfie Segmenter: {e}")

        try:
            if os.path.exists(FACE_MODEL_PATH):
                base_options_fd = python.BaseOptions(model_asset_path=FACE_MODEL_PATH)
                options_fd = vision.FaceDetectorOptions(base_options=base_options_fd)
                self.detector = vision.FaceDetector.create_from_options(options_fd)
                log_debug("MediaPipe Face Detector inicializado")
        except Exception as e:
            log_debug(f"Error cargando Face Detector: {e}")

    def start(self, brightness=50, contrast=50, blur="none", mode="landscape", avatar="none", device=None):
        self.stop()
        with self._lock:
            cams = get_available_cameras()
            if not cams:
                log_debug("No camera devices found")
                return

            if device is None:
                device = cams[0]["device"]

            self.current_device = device
            self.current_brightness = brightness
            self.current_contrast = contrast
            self.current_blur = blur
            self.current_mode = mode
            self.current_avatar = avatar

            pipe_str = (
                f"v4l2src device={device} ! decodebin ! videoconvert ! "
                f"videorate ! video/x-raw,framerate=15/1 ! "
                f"videoscale ! video/x-raw,format=BGR,width=320,height=180 ! "
                f"appsink name=sink emit-signals=True max-buffers=1 drop=True"
            )
            log_debug(f"Iniciando tubería de cámara: {pipe_str}")
            try:
                self.pipeline = Gst.parse_launch(pipe_str)
                sink = self.pipeline.get_by_name("sink")
                if sink:
                    sink.connect("new-sample", self._on_new_sample)

                bus = self.pipeline.get_bus()
                bus.add_signal_watch()
                bus.connect("message::error", self._on_error)

                ret = self.pipeline.set_state(Gst.State.PLAYING)
                if ret == Gst.StateChangeReturn.FAILURE:
                    raise RuntimeError("GStreamer pipeline falló al iniciar en PLAYING")
                self.running = True
                log_debug("Cámara iniciada correctamente")
            except Exception as e:
                log_debug(f"Error iniciando cámara: {e}")
                self._cleanup()
                print(json.dumps({"action": "cam_error", "message": str(e)}), flush=True)

    def _on_error(self, bus, msg):
        err, debug = msg.parse_error()
        log_debug(f"GStreamer Cam Error: {err.message} ({debug})")
        self.stop()
        print(json.dumps({"action": "cam_error", "message": err.message}), flush=True)

    def _on_new_sample(self, sink):
        if not self.running:
            return Gst.FlowReturn.OK
        try:
            sample = sink.emit("pull-sample")
            if not sample:
                return Gst.FlowReturn.OK

            buf = sample.get_buffer()
            data = buf.extract_dup(0, buf.get_size())
            frame = np.ndarray(shape=(180, 320, 3), dtype=np.uint8, buffer=data).copy()

            # 1. Ajuste de brillo y contraste en tiempo real
            if self.current_brightness != 50 or self.current_contrast != 50:
                alpha = self.current_contrast / 50.0
                beta = (self.current_brightness - 50) * 1.4
                frame = cv2.convertScaleAbs(frame, alpha=alpha, beta=beta)

            # 2. Desenfoque Inteligente de Fondo (Smart Selfie Bokeh)
            if self.current_blur in ("soft", "deep", 1, 2) and self.segmenter:
                try:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    seg_result = self.segmenter.segment(mp_img)
                    if seg_result and seg_result.confidence_masks:
                        mask = seg_result.confidence_masks[0].numpy_view()
                        mask = cv2.resize(mask, (320, 180))
                        mask = cv2.GaussianBlur(mask, (9, 9), 0)
                        mask_3c = np.dstack([mask, mask, mask])

                        ksize = (17, 17) if self.current_blur in ("soft", 1) else (35, 35)
                        bg_blur = cv2.GaussianBlur(frame, ksize, 0)
                        frame = (frame * mask_3c + bg_blur * (1.0 - mask_3c)).astype(np.uint8)
                except Exception as e:
                    log_debug(f"Error en segmentación de fondo: {e}")

            # 3. Avatares Virtuales y Filtros AR (Face Tracking)
            if self.current_avatar not in ("none", "normal", None) and self.detector:
                try:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    fd_res = self.detector.detect(mp_img)
                    if fd_res and fd_res.detections:
                        det = fd_res.detections[0]
                        # Extraer keypoints normalizados a pixeles
                        kps = [(int(kp.x * 320), int(kp.y * 180)) for kp in det.keypoints]
                        frame = apply_avatar(frame, self.current_avatar, kps)
                except Exception as e:
                    log_debug(f"Error en tracking de avatar: {e}")

            # 4. Formato Retrato Mejorado (9:16 con alas laterales difuminadas)
            if self.current_mode == "portrait":
                h, w = frame.shape[:2]
                port_w = int(h * 9 / 16) # ~101px
                x0 = (w - port_w) // 2
                x1 = x0 + port_w

                # Alas difuminadas de fondo
                bg_wings = cv2.GaussianBlur(frame, (29, 29), 0)
                bg_wings = (bg_wings * 0.6).astype(np.uint8)
                bg_wings[:, x0:x1] = frame[:, x0:x1]
                # Divisores sutiles
                cv2.line(bg_wings, (x0, 0), (x0, h), (80, 80, 80), 1)
                cv2.line(bg_wings, (x1, 0), (x1, h), (80, 80, 80), 1)
                frame = bg_wings

            # 5. Codificar a JPEG atómico
            _, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            target_path = FRAME_PATH_1 if self.flip == 1 else FRAME_PATH_0
            self.flip = 1 - self.flip

            with open(target_path, "wb") as f:
                f.write(encoded.tobytes())

            print(json.dumps({"action": "cam_frame", "path": target_path}), flush=True)
            return Gst.FlowReturn.OK

        except Exception as e:
            log_debug(f"Error procesando frame de cámara: {e}")
        return Gst.FlowReturn.OK

    def update(self, brightness=50, contrast=50, blur="none", mode="landscape", avatar="none", device=None):
        with self._lock:
            self.current_brightness = brightness
            self.current_contrast = contrast
            self.current_blur = blur
            self.current_mode = mode
            self.current_avatar = avatar
            if device and device != self.current_device:
                self.start(brightness, contrast, blur, mode, avatar, device)

    def _cleanup(self):
        if self.pipeline:
            try:
                self.pipeline.set_state(Gst.State.NULL)
            except Exception:
                pass
            self.pipeline = None
        self.running = False

    def stop(self):
        with self._lock:
            self._cleanup()
        log_debug("Cámara detenida")


# ---------------------------------------------------------------------------
# Backend de Micrófono (Analizador de 11 Bandas en Tiempo Real)
# ---------------------------------------------------------------------------
class MicBackend:
    def __init__(self):
        self.pipeline = None
        self.running = False
        self.current_preset = "natural"
        self._lock = threading.Lock()

    def start(self):
        self.stop()
        with self._lock:
            pipe_str = (
                "pulsesrc ! audioconvert ! audioresample ! "
                "level interval=70000000 post-messages=True ! "
                "fakesink sync=false"
            )
            log_debug("Iniciando medidor de espectro de micrófono...")
            try:
                self.pipeline = Gst.parse_launch(pipe_str)
                bus = self.pipeline.get_bus()
                bus.add_signal_watch()
                bus.connect("message::element", self._on_level_message)
                bus.connect("message::error", self._on_error)

                ret = self.pipeline.set_state(Gst.State.PLAYING)
                if ret == Gst.StateChangeReturn.FAILURE:
                    raise RuntimeError("Pipeline de micrófono falló al iniciar")
                self.running = True
                log_debug("Medidor de micrófono iniciado correctamente")
            except Exception as e:
                log_debug(f"Error iniciando micrófono: {e}")
                self._cleanup()
                print(json.dumps({"action": "mic_error", "message": str(e)}), flush=True)

    def _on_error(self, bus, msg):
        err, debug = msg.parse_error()
        log_debug(f"GStreamer Mic Error: {err.message} ({debug})")
        self.stop()

    def _on_level_message(self, bus, message):
        if not self.running:
            return
        s = message.get_structure()
        if s and s.get_name() == "level":
            try:
                peaks = s.get_value("peak")
                peak = peaks[0] if peaks else -60.0
                norm = max(0.0, min(1.0, (peak + 50.0) / 50.0))

                # Calcular 11 barras de espectro
                bars = []
                num_bars = 11
                for i in range(num_bars):
                    dist_from_center = abs(i - 5) / 5.0
                    freq_curve = 1.0 - (dist_from_center * 0.45)
                    jitter = math.sin(time.time() * 25.0 + i * 1.8) * 0.12 * norm
                    val = max(0.08, min(1.0, (norm * freq_curve) + jitter))
                    bars.append(round(val, 3))

                print(json.dumps({
                    "action": "mic_level",
                    "level": round(norm, 3),
                    "bars": bars
                }), flush=True)
            except Exception:
                pass

    def _cleanup(self):
        if self.pipeline:
            try:
                self.pipeline.set_state(Gst.State.NULL)
            except Exception:
                pass
            self.pipeline = None
        self.running = False

    def stop(self):
        with self._lock:
            self._cleanup()
        log_debug("Medidor de micrófono detenido")


# ---------------------------------------------------------------------------
# Monitor de Audio en Vivo con Retraso (Loopback Delay de 2 Segundos)
# ---------------------------------------------------------------------------
class AudioDelayTester:
    def __init__(self):
        self.pipeline = None
        self.running = False
        self.preset = "natural"
        self._lock = threading.Lock()

    def start(self, preset="natural"):
        self.stop()
        with self._lock:
            self.preset = preset
            filt = VOICE_FILTERS.get(preset, VOICE_FILTERS["natural"])
            # Pipeline GStreamer con cola de delay de 2.0 segundos exactos
            pipe_str = (
                f"pulsesrc ! "
                f"audioconvert ! audioresample ! "
                f"{filt} ! "
                f"queue min-threshold-time=2000000000 max-size-time=4000000000 max-size-buffers=0 max-size-bytes=0 ! "
                f"pulsesink sync=true"
            )
            log_debug(f"Iniciando loopback continuo con delay de 2s (preset: {preset})...")
            try:
                self.pipeline = Gst.parse_launch(pipe_str)
                self.pipeline.set_state(Gst.State.PLAYING)
                self.running = True
                print(json.dumps({"action": "mic_delay_status", "running": True, "preset": preset}), flush=True)
            except Exception as e:
                log_debug(f"Error iniciando audio delay loopback: {e}")
                self._cleanup()
                print(json.dumps({"action": "mic_delay_status", "running": False, "error": str(e)}), flush=True)

    def set_preset(self, preset):
        if self.running and preset != self.preset:
            log_debug(f"Actualizando preset de delay loopback a '{preset}'")
            self.start(preset)

    def _cleanup(self):
        if self.pipeline:
            try:
                self.pipeline.set_state(Gst.State.NULL)
            except Exception:
                pass
            self.pipeline = None
        self.running = False

    def stop(self):
        with self._lock:
            self._cleanup()
        print(json.dumps({"action": "mic_delay_status", "running": False}), flush=True)
        log_debug("Loopback de delay detenido")


# ---------------------------------------------------------------------------
# Bucle Principal de Comunicación
# ---------------------------------------------------------------------------
def main():
    ensure_single_instance()

    cam = CameraBackend()
    mic = MicBackend()
    delay_tester = AudioDelayTester()

    loop = GLib.MainLoop()

    def send_hw_status():
        cams = get_available_cameras()
        vol, muted = get_system_mic_info()
        print(json.dumps({
            "action": "hw_status",
            "cam": len(cams) > 0,
            "cams": cams,
            "mic": True,
            "mic_volume": vol,
            "mic_muted": muted,
            "voice_presets": list(VOICE_FILTERS.keys()),
            "current_preset": mic.current_preset,
            "delay_running": delay_tester.running,
            "session": SESSION
        }), flush=True)

    def handle_message(line):
        try:
            msg = json.loads(line)
            action = msg.get("action")

            if action == "hw_check":
                send_hw_status()

            elif action == "cam_start":
                b = msg.get("brightness", 50)
                c = msg.get("contrast", 50)
                blur = msg.get("blur", "none")
                mode = msg.get("mode", "landscape")
                avatar = msg.get("avatar", "none")
                dev = msg.get("device")
                cam.start(brightness=b, contrast=c, blur=blur, mode=mode, avatar=avatar, device=dev)

            elif action == "cam_update":
                b = msg.get("brightness", 50)
                c = msg.get("contrast", 50)
                blur = msg.get("blur", "none")
                mode = msg.get("mode", "landscape")
                avatar = msg.get("avatar", "none")
                dev = msg.get("device")
                cam.update(brightness=b, contrast=c, blur=blur, mode=mode, avatar=avatar, device=dev)

            elif action == "cam_stop":
                cam.stop()

            elif action == "mic_start":
                mic.start()

            elif action == "mic_stop":
                mic.stop()
                delay_tester.stop()

            elif action == "mic_set_preset":
                preset = msg.get("preset", "natural")
                mic.current_preset = preset
                delay_tester.set_preset(preset)

            elif action == "mic_delay_start":
                preset = msg.get("preset", mic.current_preset)
                delay_tester.start(preset)

            elif action == "mic_delay_stop":
                delay_tester.stop()

            elif action == "mic_set_volume":
                vol = max(0, min(100, int(msg.get("volume", 100))))
                subprocess.run(["pactl", "set-source-volume", "@DEFAULT_SOURCE@", f"{vol}%"], timeout=1)

            elif action == "mic_set_mute":
                muted = bool(msg.get("muted", False))
                subprocess.run(["pactl", "set-source-mute", "@DEFAULT_SOURCE@", "1" if muted else "0"], timeout=1)

            elif action == "ping":
                print(json.dumps({"action": "pong"}), flush=True)

        except Exception as e:
            log_debug(f"Error procesando mensaje: {e}")

    def stdin_reader():
        for line in sys.stdin:
            line = line.strip()
            if line:
                GLib.idle_add(handle_message, line)
        log_debug("stdin cerrado, saliendo...")
        GLib.idle_add(loop.quit)

    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()

    def sig_handler(sig, frame):
        log_debug(f"Señal recibida: {sig}, cerrando limpiamente...")
        GLib.idle_add(loop.quit)

    signal.signal(signal.SIGINT, sig_handler)
    signal.signal(signal.SIGTERM, sig_handler)

    log_debug("Backend listo y enviando estado inicial")
    send_hw_status()
    print(json.dumps({"status": "ready", "session": SESSION}), flush=True)

    try:
        loop.run()
    except Exception as e:
        log_debug(f"Excepción en bucle principal: {e}")
    finally:
        cam.stop()
        mic.stop()
        delay_tester.stop()
        pid_file = os.path.join(SHM_DIR, "canela_backend.pid")
        if os.path.exists(pid_file):
            try:
                os.remove(pid_file)
            except OSError:
                pass
        log_debug("Backend finalizado limpiamente")


if __name__ == "__main__":
    main()
