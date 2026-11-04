#!/usr/bin/env bash
# ==============================================================================
# Canela — Script de Desinstalación
# Remueve completamente la miniaplicación Canela del entorno Cinnamon
# ==============================================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

UUID="canela@canela"
TARGET_DIR="$HOME/.local/share/cinnamon/applets/$UUID"
CONFIG_DIR="$HOME/.config/cinnamon/spices/$UUID"

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}       Desinstalador de Canela para Cinnamon           ${NC}"
echo -e "${BLUE}======================================================${NC}"

# 1. Remover del panel de Cinnamon si está activa
echo -e "\n${YELLOW}[1/3] Removiendo de las miniaplicaciones activas en el panel...${NC}"

python3 -c "
import subprocess, ast
try:
    res = subprocess.run(['gsettings', 'get', 'org.cinnamon', 'enabled-applets'], capture_output=True, text=True)
    applets = ast.literal_eval(res.stdout.strip())
    new_applets = [a for a in applets if '$UUID' not in a]
    if len(new_applets) != len(applets):
        subprocess.run(['gsettings', 'set', 'org.cinnamon', 'enabled-applets', str(new_applets)])
        print('  ✓ Canela ha sido removida del panel de Cinnamon')
    else:
        print('  ✓ No estaba activa en el panel')
except Exception as e:
    print('  Advertencia al verificar gsettings:', e)
"

# 2. Eliminar directorios de la miniaplicación
echo -e "\n${YELLOW}[2/3] Eliminando archivos de la miniaplicación...${NC}"

if [ -d "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
    echo -e "${GREEN}  ✓ Directorio eliminado: $TARGET_DIR${NC}"
else
    echo -e "  ✓ No se encontró el directorio de applet (ya estaba limpio)"
fi

if [ -d "$CONFIG_DIR" ]; then
    rm -rf "$CONFIG_DIR"
    echo -e "${GREEN}  ✓ Configuración eliminada: $CONFIG_DIR${NC}"
fi

# Limpieza de archivos temporales en memoria compartida
rm -f /dev/shm/canela_frame_*.jpg /dev/shm/canela_test_mic.wav /tmp/canela_*.jpg 2>/dev/null || true

# 3. Notificar a Cinnamon
echo -e "\n${YELLOW}[3/3] Notificando a Cinnamon...${NC}"

if command -v dbus-send &> /dev/null; then
    dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon org.Cinnamon.ReloadXlet string:"$UUID" string:"APPLET" 2>/dev/null || true
    echo -e "${GREEN}  ✓ Recarga de Cinnamon notificada${NC}"
fi

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}   ¡Canela ha sido desinstalada por completo!         ${NC}"
echo -e "${GREEN}======================================================${NC}"
echo -e "La miniaplicación ya no aparecerá en el listado de Miniaplicaciones del sistema.\n"
