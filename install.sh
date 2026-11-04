#!/usr/bin/env bash
# ==============================================================================
# Canela — Script de Instalación
# Miniaplicación de Cinnamon para preview y calibración de cámara y micrófono
# ==============================================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

UUID="canela@canela"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.local/share/cinnamon/applets/$UUID"

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}        Instalador de Canela para Cinnamon             ${NC}"
echo -e "${BLUE}======================================================${NC}"

# 1. Comprobar dependencias recomendadas
echo -e "\n${YELLOW}[1/4] Comprobando dependencias...${NC}"

check_cmd() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${YELLOW}  Advertencia: '$1' no está instalado en el sistema.${NC}"
        return 1
    else
        echo -e "${GREEN}  ✓ $1 encontrado${NC}"
        return 0
    fi
}

check_cmd python3
check_cmd pactl
check_cmd parecord
check_cmd paplay
check_cmd gst-launch-1.0

# Comprobar bindings de Python GStreamer, OpenCV y MediaPipe
if python3 -c "import gi; gi.require_version('Gst', '1.0'); from gi.repository import Gst" 2>/dev/null; then
    echo -e "${GREEN}  ✓ Python GStreamer (Gst 1.0) disponible${NC}"
else
    echo -e "${RED}  ✗ Python GStreamer no está disponible.${NC}"
fi

if python3 -c "import cv2, mediapipe" 2>/dev/null; then
    echo -e "${GREEN}  ✓ OpenCV y MediaPipe disponibles para IA y Avatares${NC}"
else
    echo -e "${YELLOW}  Advertencia: OpenCV o MediaPipe no detectados.${NC}"
fi

# 2. Crear directorio de destino e instalar archivos
echo -e "\n${YELLOW}[2/4] Copiando archivos de la miniaplicación...${NC}"

mkdir -p "$TARGET_DIR"

cp -v "$SCRIPT_DIR/metadata.json" "$TARGET_DIR/"
cp -v "$SCRIPT_DIR/applet.js" "$TARGET_DIR/"
cp -v "$SCRIPT_DIR/backend.py" "$TARGET_DIR/"
cp -v "$SCRIPT_DIR/settings-schema.json" "$TARGET_DIR/"
cp -v "$SCRIPT_DIR/stylesheet.css" "$TARGET_DIR/"

if [ -d "$SCRIPT_DIR/models" ]; then
    mkdir -p "$TARGET_DIR/models"
    cp -v "$SCRIPT_DIR/models/"* "$TARGET_DIR/models/"
fi

chmod +x "$TARGET_DIR/backend.py"

echo -e "${GREEN}  ✓ Archivos copiados en: $TARGET_DIR${NC}"

# 3. Registrar / Recargar en Cinnamon
echo -e "\n${YELLOW}[3/4] Notificando a Cinnamon...${NC}"

if command -v dbus-send &> /dev/null; then
    # Intentar recargar el applet si ya está en ejecución
    dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon org.Cinnamon.ReloadXlet string:"$UUID" string:"APPLET" 2>/dev/null || true
    echo -e "${GREEN}  ✓ Cinnamon notificado para recargar xlets${NC}"
fi

# 4. Habilitar en panel opcionalmente
echo -e "\n${YELLOW}[4/4] Configuración del panel...${NC}"

ENABLE_NOW=false
if [[ "$1" == "--enable" || "$1" == "-e" ]]; then
    ENABLE_NOW=true
else
    # Preguntar si se quiere agregar al panel directamente
    read -p "¿Deseas agregar Canela al panel ahora mismo? [S/n]: " -n 1 -r REPLY
    echo ""
    if [[ $REPLY =~ ^[Ss]$ || -z $REPLY ]]; then
        ENABLE_NOW=true
    fi
fi

if [ "$ENABLE_NOW" = true ]; then
    CURRENT_APPLETS=$(gsettings get org.cinnamon enabled-applets 2>/dev/null || echo "[]")
    if [[ "$CURRENT_APPLETS" == *"$UUID"* ]]; then
        echo -e "${GREEN}  ✓ Canela ya se encuentra activa en tu panel de Cinnamon.${NC}"
    else
        # Encontrar el siguiente ID disponible
        NEXT_ID=20
        # Agregar al extremo derecho del panel 1
        python3 -c "
import subprocess, ast
res = subprocess.run(['gsettings', 'get', 'org.cinnamon', 'enabled-applets'], capture_output=True, text=True)
try:
    applets = ast.literal_eval(res.stdout.strip())
except Exception:
    applets = []

max_id = 15
for a in applets:
    parts = a.split(':')
    if len(parts) >= 5 and parts[4].isdigit():
        max_id = max(max_id, int(parts[4]))

new_applet = f'panel1:right:2:$UUID:{max_id + 1}'
if not any('$UUID' in a for a in applets):
    applets.append(new_applet)
    val = str(applets)
    subprocess.run(['gsettings', 'set', 'org.cinnamon', 'enabled-applets', val])
    print('  ✓ Agregado a la configuración del panel')
else:
    print('  ✓ Ya presente en la configuración')
"
    fi
fi

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}   ¡Canela ha sido instalada exitosamente!            ${NC}"
echo -e "${GREEN}======================================================${NC}"
echo -e "Puedes activarla o configurarla desde:"
echo -e "  Configuración del sistema -> Miniaplicaciones -> Canela"
echo -e "O ejecutar ./uninstall.sh si deseas removerla por completo.\n"
