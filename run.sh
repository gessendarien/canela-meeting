#!/usr/bin/env bash
# ============================================================================
# Canela — run.sh
# Instala dependencias, organiza la estructura y activa el applet en Cinnamon.
# ============================================================================

set -euo pipefail

UUID="canela@canela"
APPLET_DIR="$HOME/.local/share/cinnamon/applets/$UUID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ============================================================================
# 1. Verificar que estamos en Cinnamon
# ============================================================================

info "Verificando entorno de escritorio..."

if ! command -v cinnamon &>/dev/null; then
    error "Cinnamon no está instalado. Este applet es para Linux Mint / Cinnamon."
    exit 1
fi
success "Cinnamon detectado."

# ============================================================================
# 2. Instalar dependencias del sistema
# ============================================================================

DEPS=(
    gstreamer1.0-tools
    gstreamer1.0-plugins-base
    gstreamer1.0-plugins-good
    gstreamer1.0-plugins-bad
    python3-gi
    gir1.2-gstreamer-1.0
)

OPTIONAL_DEPS=(
    pipewire
    pipewire-pulse
    wireplumber
    v4l2loopback-dkms
)

info "Verificando dependencias..."

MISSING=()
for pkg in "${DEPS[@]}"; do
    if ! dpkg -s "$pkg" &>/dev/null; then
        MISSING+=("$pkg")
    fi
done

MISSING_OPT=()
for pkg in "${OPTIONAL_DEPS[@]}"; do
    if ! dpkg -s "$pkg" &>/dev/null; then
        MISSING_OPT+=("$pkg")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    warn "Faltan dependencias obligatorias: ${MISSING[*]}"
    info "Instalando con apt..."
    sudo apt update -qq
    sudo apt install -y "${MISSING[@]}"
    success "Dependencias obligatorias instaladas."
else
    success "Todas las dependencias obligatorias ya están instaladas."
fi

if [ ${#MISSING_OPT[@]} -gt 0 ]; then
    warn "Dependencias opcionales no instaladas: ${MISSING_OPT[*]}"
    read -rp "¿Instalar dependencias opcionales (PipeWire, v4l2loopback)? [s/N]: " resp
    if [[ "$resp" =~ ^[sS]$ ]]; then
        sudo apt install -y "${MISSING_OPT[@]}"
        success "Dependencias opcionales instaladas."
    else
        info "Saltando dependencias opcionales."
    fi
fi

# ============================================================================
# 3. Dispositivos Virtuales (Cámara y Micrófono)
# ============================================================================

if dpkg -s v4l2loopback-dkms &>/dev/null; then
    info "Cargando módulo v4l2loopback con exclusive_caps=1..."
    sudo rmmod v4l2loopback 2>/dev/null || true
    sudo modprobe v4l2loopback video_nr=2 card_label="Canela Cam" exclusive_caps=1 || warn "No se pudo cargar v4l2loopback."
    success "v4l2loopback configurado correctamente."
fi

if command -v pactl &>/dev/null; then
    info "Configurando micrófono virtual 'Canela Mic'..."
    pactl unload-module module-null-sink &>/dev/null || true
    pactl load-module module-null-sink sink_name=CanelaSink sink_properties=device.description="Canela\ Mic" >/dev/null || warn "No se pudo crear Canela Mic."
    success "Microfono virtual configurado."
fi

# ============================================================================
# 4. Copiar archivos del applet a la ubicación de Cinnamon
# ============================================================================

info "Instalando applet en $APPLET_DIR ..."

mkdir -p "$APPLET_DIR"

if [ -d "$SCRIPT_DIR/$UUID" ]; then
    cp -rv "$SCRIPT_DIR/$UUID/"* "$APPLET_DIR/"
else
    error "No se encontró la carpeta $UUID en $SCRIPT_DIR"
    exit 1
fi

# Asegurar que backend.py sea ejecutable
chmod +x "$APPLET_DIR/backend.py"

success "Archivos del applet copiados."

# ============================================================================
# 5. Activar el applet en Cinnamon (si no está ya activo)
# ============================================================================

info "Verificando si el applet ya está activo..."

CURRENT_APPLETS=$(gsettings get org.cinnamon enabled-applets)

if echo "$CURRENT_APPLETS" | grep -q "$UUID"; then
    success "El applet ya está activo en el panel."
else
    info "Activando applet en el panel..."
    NEW_APPLETS=$(echo "$CURRENT_APPLETS" | sed "s/]$/, 'panel1:right:0:${UUID}:0']/")
    gsettings set org.cinnamon enabled-applets "$NEW_APPLETS"
    success "Applet activado en el panel (panel1, derecha)."
fi

# ============================================================================
# 6. Reiniciar Cinnamon para aplicar cambios
# ============================================================================

echo ""
info "============================================"
success "¡Canela instalado correctamente!"
info "============================================"
echo ""
info "Opciones para activar:"
echo "  1) Pulsa Alt+F2 → escribe 'r' → Enter (reinicia Cinnamon sin cerrar ventanas)"
echo "  2) O cierra y vuelve a iniciar sesión"
echo ""

read -rp "¿Reiniciar Cinnamon ahora? (Alt+F2 → r) [s/N]: " restart
if [[ "$restart" =~ ^[sS]$ ]]; then
    info "Reiniciando Cinnamon..."
    nohup bash -c 'sleep 1 && dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon org.Cinnamon.Eval string:"global.reexec_self()"' &>/dev/null &
    success "Cinnamon se reiniciará en 1 segundo."
else
    info "Recuerda reiniciar Cinnamon manualmente (Alt+F2 → r)."
fi
