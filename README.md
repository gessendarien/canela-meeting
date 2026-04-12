# Canela — Cam & Mic settings for meeting
**Version:** 0.0.1

## Descripción
Applet para el panel de Linux Mint Cinnamon que permite configurar cámara y micrófono
directamente desde el panel, sin abrir ninguna aplicación externa.
Detecta automáticamente si la sesión es X11 o Wayland y usa el backend correcto.

---

## Estructura del proyecto

```
canela@canela/
├── metadata.json        ← Información del applet (nombre, versión, uuid)
├── settings-schema.json ← Definición de todos los sliders y estados persistentes
├── applet.js            ← UI del applet en el panel (GJS / Cinnamon API)
├── backend.py           ← Control real de cámara y mic con GStreamer
├── stylesheet.css       ← Estilos del menú popup
└── README.md            ← Este archivo
```

---

## Instalación

### 1. Dependencias

```bash
# GStreamer y plugins necesarios
sudo apt install \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    python3-gi \
    gir1.2-gstreamer-1.0

# Para Wayland (PipeWire — ya incluido en Mint 21+)
sudo apt install pipewire pipewire-pulse wireplumber

# Para el loopback de cámara virtual (opcional pero recomendado)
sudo apt install v4l2loopback-dkms
sudo modprobe v4l2loopback
```

### 2. Copiar el applet

```bash
mkdir -p ~/.local/share/cinnamon/applets/
cp -r canela@canela ~/.local/share/cinnamon/applets/
```

### 3. Activar en Cinnamon

- Clic derecho en el panel → **Agregar miniaplicaciones al panel**
- Buscar **Canela**
- Clic en **Agregar**

O desde terminal:
```bash
gsettings set org.cinnamon enabled-applets \
  "$(gsettings get org.cinnamon enabled-applets | sed "s/]$/, 'panel1:right:0:canela@canela:0']/")"
```

---

## Cómo funciona la detección X11 / Wayland

`backend.py` lee la variable de entorno `XDG_SESSION_TYPE` al iniciarse:

| Sesión   | Fuente cámara  | Fuente audio |
|----------|---------------|--------------|
| X11      | `v4l2src`     | `pulsesrc`   |
| Wayland  | `pipewiresrc` | `pipewiresrc`|

Si en el futuro Mint migra a Wayland, **no se necesita reescribir nada** —
el backend ya elige el pipeline correcto automáticamente.

---

## Comunicación applet.js ↔ backend.py

El applet lanza `backend.py` como subproceso y se comunica via **JSON por stdin/stdout**:

```json
// Applet → Backend
{ "action": "cam_update", "brightness": 72, "contrast": 45, "blur": 20 }
{ "action": "mic_update", "gain": 65, "reverb": 30, "noise_reduction": 40, "mic_range": 50 }
{ "action": "cam_stop" }
{ "action": "mic_stop" }

// Backend → Applet
{ "status": "ready", "session": "x11" }
{ "status": "ok", "action": "cam_update", "session": "x11" }
```

---

## Cámara virtual (loopback)

Para que las videollamadas (Meet, Zoom, Teams) vean los efectos de Canela,
se necesita un dispositivo virtual:

```bash
# Cargar el módulo (temporal)
sudo modprobe v4l2loopback video_nr=2 card_label="Canela Cam"

# Hacerlo permanente
echo "v4l2loopback" | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo 'options v4l2loopback video_nr=2 card_label="Canela Cam"' | \
  sudo tee /etc/modprobe.d/v4l2loopback.conf
```

Luego en tu app de videollamada selecciona **"Canela Cam"** como cámara.
