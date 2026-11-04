const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cogl = imports.gi.Cogl;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Tweener = imports.ui.tweener;

let APPLET_DIR = GLib.build_filenamev([GLib.get_home_dir(), ".local", "share", "cinnamon", "applets", "canela@canela"]);

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function CanelaApplet(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

CanelaApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(metadata, orientation, panel_height, instance_id) {
        Applet.IconApplet.prototype._init.call(this, orientation, panel_height, instance_id);

        if (metadata && metadata.path) {
            APPLET_DIR = metadata.path;
        }

        this.set_applet_icon_symbolic_name("camera-web-symbolic");
        this.set_applet_tooltip("Canela — Configuración de Cámara y Micrófono");

        this.settings = new Settings.AppletSettings(this, "canela@canela", instance_id);
        this._bindSettings();

        this._camAvailable   = false;
        this._micAvailable   = false;
        this._delayRunning   = false;

        this._camPreviewBin  = null;
        this._camContentImage = null;
        this._spectrumBars   = [];
        this._openAccordions = {};

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        if (this.menu.actor) {
            this.menu.actor.add_style_class_name("canela-menu-window");
        }
        if (this.menu.box) {
            this.menu.box.add_style_class_name("canela-popup-box");
        }

        let self = this;
        this.actor.connect("destroy", function() {
            self.on_applet_removed_from_panel();
        });

        this.menu.connect("open-state-changed", function(menu, isOpen) {
            self._onMenuOpenState(isOpen);
        });

        this._buildMenu();
        this._startBackend();
    },

    // -----------------------------------------------------------------------
    // Configuración y Propiedades
    // -----------------------------------------------------------------------

    _getSource: function() {
        return this._s_active_source || "cam";
    },

    _bindSettings: function() {
        let self = this;
        let s = this.settings;

        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "active-source", "_s_active_source", function() {
            self._updateAppletIcon();
        });
        s.bindProperty(Settings.BindingDirection.IN, "accent-color", "_s_accent_color");
        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "cam-brightness", "_s_cam_brightness", function() { self._syncBackend(); });
        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "cam-contrast", "_s_cam_contrast", function() { self._syncBackend(); });
        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "cam-blur", "_s_cam_blur", function() { self._syncBackend(); });
        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "cam-mode", "_s_cam_mode", function() { self._syncBackend(); });
        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "cam-avatar", "_s_cam_avatar", function() { self._syncBackend(); });
        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "cam-muted", "_s_cam_muted", function() {
            self._updateAppletIcon();
            self._syncBackend();
            self._buildMenu();
        });

        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "mic-gain", "_s_mic_gain", function() { self._syncBackend(); });
        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "mic-voice-preset", "_s_mic_preset", function() { self._syncBackend(); });
        s.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, "mic-muted", "_s_mic_muted", function() {
            self._updateAppletIcon();
            self._syncBackend();
            self._buildMenu();
        });
    },

    _updateAppletIcon: function() {
        let src = this._getSource();
        if (src === "cam") {
            this.set_applet_icon_symbolic_name(
                this._s_cam_muted ? "camera-disabled-symbolic" : "camera-web-symbolic"
            );
        } else {
            this.set_applet_icon_symbolic_name(
                this._s_mic_muted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic"
            );
        }
    },

    // -----------------------------------------------------------------------
    // Subproceso Backend (Python IPC)
    // -----------------------------------------------------------------------

    _startBackend: function() {
        try {
            let flags = Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE;
            this._subprocess = Gio.Subprocess.new(
                ["/usr/bin/python3", APPLET_DIR + "/backend.py"],
                flags
            );

            this._backendStdin = new Gio.DataOutputStream({
                base_stream: this._subprocess.get_stdin_pipe()
            });

            this._backendStdout = new Gio.DataInputStream({
                base_stream: this._subprocess.get_stdout_pipe()
            });

            this._readBackendLine();
        } catch(e) {
            global.logError("[Canela] Error iniciando backend: " + e.message);
        }
    },

    _readBackendLine: function() {
        if (!this._backendStdout) return;

        let self = this;
        this._backendStdout.read_line_async(
            GLib.PRIORITY_DEFAULT, null,
            function(stream, result) {
                try {
                    let [line, length] = stream.read_line_finish(result);
                    if (line === null) return;

                    let lineStr;
                    if (line instanceof Uint8Array || (line.length !== undefined && typeof line !== "string")) {
                        lineStr = imports.byteArray.toString(line);
                    } else {
                        lineStr = String(line);
                    }
                    if (lineStr && lineStr.trim().length > 0) {
                        self._handleBackendMsg(JSON.parse(lineStr.trim()));
                    }
                } catch(e) {}
                self._readBackendLine();
            }
        );
    },

    _handleBackendMsg: function(msg) {
        if (msg.action === "hw_status") {
            let changed = (this._camAvailable !== msg.cam) || (this._micAvailable !== msg.mic);
            this._camAvailable = msg.cam;
            this._micAvailable = msg.mic;

            if (msg.mic_volume !== undefined) {
                this.settings.setValue("mic-gain", msg.mic_volume);
            }
            if (msg.mic_muted !== undefined) {
                this.settings.setValue("mic-muted", msg.mic_muted);
            }
            if (msg.delay_running !== undefined) {
                this._delayRunning = msg.delay_running;
            }

            this._updateAppletIcon();
            if (changed) {
                this._buildMenu();
            }
            if (this.menu.isOpen) {
                this._activateCurrentSource();
            }
        }

        if (msg.action === "cam_frame") {
            this._onCamFrameReceived(msg.path);
        }

        if (msg.action === "mic_level") {
            this._onMicLevelReceived(msg.level, msg.bars);
        }

        if (msg.action === "mic_delay_status") {
            this._delayRunning = !!msg.running;
            if (this._delayBtn) {
                if (this._delayRunning) {
                    this._delayBtn.label = "⏹️ Detener prueba en vivo";
                    this._delayBtn.add_style_class_name("active");
                } else {
                    this._delayBtn.label = "🎧 Probar mi voz en vivo (Delay 2s)";
                    this._delayBtn.remove_style_class_name("active");
                }
            }
        }

        if (msg.status === "ready") {
            if (this.menu.isOpen) {
                this._activateCurrentSource();
            }
        }
    },

    _sendBackend: function(obj) {
        if (!this._backendStdin) return;
        try {
            this._backendStdin.put_string(JSON.stringify(obj) + "\n", null);
            this._backendStdin.flush(null);
        } catch(e) {}
    },

    _syncBackend: function() {
        let s = this.settings;
        let src = this._getSource();
        if (src === "cam") {
            if (this._s_cam_muted) {
                this._sendBackend({ action: "cam_stop" });
            } else if (this.menu.isOpen) {
                this._sendBackend({
                    action:     "cam_update",
                    brightness: s.getValue("cam-brightness"),
                    contrast:   s.getValue("cam-contrast"),
                    blur:       s.getValue("cam-blur") || "none",
                    mode:       s.getValue("cam-mode") || "landscape",
                    avatar:     s.getValue("cam-avatar") || "none"
                });
            }
        } else {
            this._sendBackend({
                action: "mic_set_volume",
                volume: s.getValue("mic-gain")
            });
            this._sendBackend({
                action: "mic_set_mute",
                muted:  s.getValue("mic-muted")
            });
            this._sendBackend({
                action: "mic_set_preset",
                preset: s.getValue("mic-voice-preset") || "natural"
            });
        }
    },

    _onMenuOpenState: function(isOpen) {
        if (isOpen) {
            this._sendBackend({ action: "hw_check" });
            this._activateCurrentSource();
        } else {
            this._sendBackend({ action: "cam_stop" });
            this._sendBackend({ action: "mic_stop" });
            this._sendBackend({ action: "mic_delay_stop" });
            this._delayRunning = false;
        }
    },

    _activateCurrentSource: function() {
        let s = this.settings;
        let src = this._getSource();
        if (src === "cam") {
            this._sendBackend({ action: "mic_stop" });
            this._sendBackend({ action: "mic_delay_stop" });
            this._delayRunning = false;
            if (!this._s_cam_muted && this._camAvailable) {
                this._sendBackend({
                    action:     "cam_start",
                    brightness: s.getValue("cam-brightness"),
                    contrast:   s.getValue("cam-contrast"),
                    blur:       s.getValue("cam-blur") || "none",
                    mode:       s.getValue("cam-mode") || "landscape",
                    avatar:     s.getValue("cam-avatar") || "none"
                });
            }
        } else {
            this._sendBackend({ action: "cam_stop" });
            if (this._micAvailable) {
                this._sendBackend({ action: "mic_start" });
                this._sendBackend({
                    action: "mic_set_preset",
                    preset: s.getValue("mic-voice-preset") || "natural"
                });
            }
        }
    },

    _onCamFrameReceived: function(path) {
        if (!this.menu.isOpen || this._getSource() !== "cam" || this._s_cam_muted || !this._camPreviewBin) {
            return;
        }

        try {
            let pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 304, 172, false);
            if (!pb) return;

            let format = pb.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888;
            if (!this._camContentImage) {
                this._camContentImage = new Clutter.Image();
            }
            this._camContentImage.set_data(
                pb.get_pixels(),
                format,
                pb.get_width(),
                pb.get_height(),
                pb.get_rowstride()
            );

            this._camPreviewBin.set_content(this._camContentImage);
            this._camPreviewBin.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
        } catch(e) {}
    },

    _onMicLevelReceived: function(normLevel, bars) {
        if (!this.menu.isOpen || this._getSource() !== "mic" || !this._spectrumBars || this._spectrumBars.length === 0) {
            return;
        }

        try {
            let numBars = Math.min(this._spectrumBars.length, bars ? bars.length : 0);
            for (let i = 0; i < numBars; i++) {
                let bar = this._spectrumBars[i];
                let bVal = bars[i];
                let h = Math.round(6 + (bVal * 44));
                bar.set_height(Math.max(6, Math.min(50, h)));
            }
        } catch(e) {}
    },

    // -----------------------------------------------------------------------
    // Construcción de la Interfaz (Acordeón Comprimido macOS)
    // -----------------------------------------------------------------------

    _buildMenu: function() {
        this.menu.removeAll();

        let self = this;
        let s = this.settings;
        let src = this._getSource();
        let available = src === "cam" ? this._camAvailable : this._micAvailable;

        // ── CABECERA CENTRADA "Canela" ────────────────────────────────────
        let headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let headerBox = new St.BoxLayout({ style_class: "canela-header" });
        
        let headerIcon = new St.Icon({
            icon_name: "camera-web-symbolic",
            icon_size: 17,
            style_class: "canela-header-icon"
        });
        let headerTitle = new St.Label({
            text: "Canela",
            style_class: "canela-title"
        });
        if (headerTitle.clutter_text) {
            headerTitle.clutter_text.set_ellipsize(imports.gi.Pango.EllipsizeMode.NONE);
        }
        headerBox.add(headerIcon);
        headerBox.add(headerTitle);

        headerItem.addActor(
            new St.Bin({ child: headerBox, x_fill: false, x_align: St.Align.MIDDLE }),
            { expand: true }
        );
        this.menu.addMenuItem(headerItem);

        // ── SELECTOR DE FUENTE (Cámara / Micrófono) ───────────────────────
        let topItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let topBox  = new St.BoxLayout({ style_class: "canela-top-btns" });

        let camBtn = new St.Button({
            style_class: "canela-top-btn" + (src === "cam" ? " active" : ""),
            reactive: true
        });
        camBtn.set_child(new St.Icon({ icon_name: "camera-web-symbolic", icon_size: 19 }));
        camBtn.connect("clicked", function() { self._setSource("cam"); });

        let micBtn = new St.Button({
            style_class: "canela-top-btn" + (src === "mic" ? " active" : ""),
            reactive: true
        });
        micBtn.set_child(new St.Icon({ icon_name: "audio-input-microphone-symbolic", icon_size: 19 }));
        micBtn.connect("clicked", function() { self._setSource("mic"); });

        topBox.add(camBtn);
        topBox.add(micBtn);
        topItem.addActor(
            new St.Bin({ child: topBox, x_fill: false, x_align: St.Align.MIDDLE }),
            { expand: true }
        );
        this.menu.addMenuItem(topItem);

        // ── MARCO DE PREVIEW FIJO (304x172) ───────────────────────────────
        let previewItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });

        if (src === "cam") {
            let camBox = new St.BoxLayout({
                vertical: true,
                style_class: "canela-preview-box"
            });

            if (!this._camAvailable) {
                let emptyBox = new St.BoxLayout({
                    vertical: true,
                    style: "width: 304px; height: 172px; padding: 25px;"
                });
                let warnIcon = new St.Icon({
                    icon_name: "camera-disabled-symbolic",
                    icon_size: 34,
                    style: "color: #ff3b30; margin-bottom: 6px;"
                });
                let warnLbl = new St.Label({
                    text: "Cámara no disponible",
                    style: "font-size: 12px; font-weight: 600; color: #ffffff;"
                });
                emptyBox.add(new St.Bin({ child: warnIcon, x_align: St.Align.MIDDLE }), { expand: true });
                emptyBox.add(new St.Bin({ child: warnLbl, x_align: St.Align.MIDDLE }));
                camBox.add(emptyBox);

            } else if (this._s_cam_muted) {
                let offBox = new St.BoxLayout({
                    vertical: true,
                    style: "width: 304px; height: 172px; padding: 25px;"
                });
                let offIcon = new St.Icon({
                    icon_name: "camera-disabled-symbolic",
                    icon_size: 34,
                    style: "color: rgba(255,255,255,0.4); margin-bottom: 6px;"
                });
                let offLbl = new St.Label({
                    text: "Cámara desactivada",
                    style: "font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.7);"
                });
                offBox.add(new St.Bin({ child: offIcon, x_align: St.Align.MIDDLE }), { expand: true });
                offBox.add(new St.Bin({ child: offLbl, x_align: St.Align.MIDDLE }));
                camBox.add(offBox);

            } else {
                this._camPreviewBin = new St.Bin({
                    width: 304,
                    height: 172,
                    x_fill: true,
                    y_fill: true
                });
                this._camPreviewBin.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);

                if (this._camContentImage) {
                    this._camPreviewBin.set_content(this._camContentImage);
                }
                camBox.add(this._camPreviewBin);
            }

            previewItem.addActor(
                new St.Bin({ child: camBox, x_fill: false, x_align: St.Align.MIDDLE }),
                { expand: true }
            );

        } else {
            // Preview de Micrófono con 11 Barras Simétricas
            let micBox = new St.BoxLayout({
                vertical: true,
                style_class: "canela-preview-mic-box"
            });

            let micIconColor = this._s_mic_muted ? "#ff3b30" : "#34c759";
            let micIcon = new St.Icon({
                icon_name: this._s_mic_muted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic",
                icon_size: 30,
                style: "color: " + micIconColor + "; margin-top: 2px;"
            });
            micBox.add(new St.Bin({ child: micIcon, x_align: St.Align.MIDDLE }));

            let micLbl = new St.Label({
                text: this._s_mic_muted ? "Micrófono Silenciado" : "Habla para probar tu micrófono",
                style: "font-size: 11px; font-weight: 500; color: #636366; margin-bottom: 4px;"
            });
            micBox.add(new St.Bin({ child: micLbl, x_align: St.Align.MIDDLE }));

            let specBox = new St.BoxLayout({
                style_class: "canela-spectrum-container"
            });
            this._spectrumBars = [];
            for (let i = 0; i < 11; i++) {
                let barBin = new St.Bin({
                    style_class: "canela-spectrum-bar",
                    y_align: St.Align.MIDDLE,
                    height: 6
                });
                specBox.add(barBin);
                this._spectrumBars.push(barBin);
            }
            micBox.add(new St.Bin({ child: specBox, x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE }));

            // Botón de Prueba en Vivo (Delay 2s)
            this._delayBtn = new St.Button({
                label: this._delayRunning ? "⏹️ Detener prueba en vivo" : "🎧 Probar mi voz en vivo (Delay 2s)",
                style_class: "canela-delay-btn" + (this._delayRunning ? " active" : ""),
                reactive: available
            });
            this._delayBtn.connect("clicked", function() {
                self._toggleDelayLoopback();
            });

            let delayHint = new St.Label({
                text: "Escucharás tu voz 2s después con el efecto aplicado",
                style_class: "canela-delay-hint"
            });

            let btnContainer = new St.BoxLayout({ vertical: true });
            btnContainer.add(this._delayBtn);
            btnContainer.add(delayHint);

            micBox.add(new St.Bin({ child: btnContainer, x_align: St.Align.MIDDLE }));

            previewItem.addActor(
                new St.Bin({ child: micBox, x_fill: false, x_align: St.Align.MIDDLE }),
                { expand: true }
            );
        }
        this.menu.addMenuItem(previewItem);

        // ── CONTROLES EN ACORDEÓN COMPRIMIDO ──────────────────────────────
        if (src === "cam") {
            // 1. Acordeón: Fondo Difuminado (MediaPipe Smart Bokeh)
            this._addAccordionRow(
                "cam_blur",
                "Fondo Difuminado",
                "camera-photo-symbolic",
                this._getBlurLabel(s.getValue("cam-blur")),
                function() {
                    return self._createPillsRow([
                        { id: "none", label: "Desactivado" },
                        { id: "soft", label: "Suave" },
                        { id: "deep", label: "Profundo" }
                    ], s.getValue("cam-blur") || "none", function(newVal) {
                        s.setValue("cam-blur", newVal);
                        self._syncBackend();
                        self._updateAccordionBadge("cam_blur", self._getBlurLabel(newVal));
                    }, available);
                }
            );

            // 2. Acordeón: Avatar y Filtros AR (Face Tracking)
            this._addAccordionRow(
                "cam_avatar",
                "Avatar y Filtros AR",
                "face-smile-symbolic",
                this._getAvatarLabel(s.getValue("cam-avatar")),
                function() {
                    return self._createPillsRow([
                        { id: "none",   label: "Ninguno" },
                        { id: "dog",    label: "🐶 Perrito" },
                        { id: "cat",    label: "🐱 Gatito" },
                        { id: "panda",  label: "🐼 Panda" },
                        { id: "cyber",  label: "🕶️ Cyber" }
                    ], s.getValue("cam-avatar") || "none", function(newVal) {
                        s.setValue("cam-avatar", newVal);
                        self._syncBackend();
                        self._updateAccordionBadge("cam_avatar", self._getAvatarLabel(newVal));
                    }, available);
                }
            );

            // 3. Acordeón: Formato de Video
            this._addAccordionRow(
                "cam_mode",
                "Formato",
                "video-display-symbolic",
                s.getValue("cam-mode") === "portrait" ? "9:16 Retrato" : "16:9 Paisaje",
                function() {
                    return self._createPillsRow([
                        { id: "landscape", label: "Paisaje (16:9)" },
                        { id: "portrait",  label: "Retrato (9:16)" }
                    ], s.getValue("cam-mode") || "landscape", function(newVal) {
                        s.setValue("cam-mode", newVal);
                        self._syncBackend();
                        self._updateAccordionBadge("cam_mode", newVal === "portrait" ? "9:16 Retrato" : "16:9 Paisaje");
                    }, available);
                }
            );

            // 4. Acordeón: Luz y Color (Agrupa Brillo y Contraste)
            let bVal = s.getValue("cam-brightness");
            let cVal = s.getValue("cam-contrast");
            this._addAccordionRow(
                "cam_light",
                "Luz y Color",
                "display-brightness-symbolic",
                "B:" + bVal + "% / C:" + cVal + "%",
                function() {
                    let box = new St.BoxLayout({ vertical: true, style: "padding: 4px;" });
                    box.add(self._createSliderRow("Brillo", "cam-brightness", 0, 100, available, function() {
                        self._updateLightBadge();
                    }));
                    box.add(self._createSliderRow("Contraste", "cam-contrast", 0, 100, available, function() {
                        self._updateLightBadge();
                    }));
                    return box;
                }
            );

        } else {
            // Pestaña de Micrófono
            // 1. Acordeón: Efectos de Voz
            this._addAccordionRow(
                "mic_preset",
                "Efecto de Voz",
                "audio-volume-high-symbolic",
                this._getPresetLabel(s.getValue("mic-voice-preset")),
                function() {
                    return self._createPillsRow([
                        { id: "natural",   label: "Natural" },
                        { id: "studio",    label: "Estudio" },
                        { id: "radio",     label: "Radio" },
                        { id: "megaphone", label: "Megáfono" },
                        { id: "echo",      label: "Eco" }
                    ], s.getValue("mic-voice-preset") || "natural", function(newVal) {
                        s.setValue("mic-voice-preset", newVal);
                        self._syncBackend();
                        self._updateAccordionBadge("mic_preset", self._getPresetLabel(newVal));
                    }, available);
                }
            );

            // 2. Acordeón: Nivel de Entrada
            let micGain = s.getValue("mic-gain");
            this._addAccordionRow(
                "mic_volume",
                "Nivel de Entrada",
                "audio-input-microphone-symbolic",
                micGain + "%",
                function() {
                    let box = new St.BoxLayout({ vertical: true, style: "padding: 4px;" });
                    box.add(self._createSliderRow("Volumen", "mic-gain", 0, 100, available, function(v) {
                        self._updateAccordionBadge("mic_volume", v + "%");
                    }));
                    return box;
                }
            );
        }

        // ── BOTÓN PRINCIPAL DE MUTE (Centro Inferior) ──────────────────────
        let muteItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let muteBox = new St.BoxLayout({
            vertical: true,
            style: "padding: 6px 0 2px 0;"
        });

        let isMuted = src === "cam" ? this._s_cam_muted : this._s_mic_muted;
        let muteBtn = new St.Button({
            style_class: "canela-mute-btn" + (isMuted ? " muted" : ""),
            reactive: available
        });

        let muteIconName;
        if (src === "cam") {
            muteIconName = isMuted ? "camera-disabled-symbolic" : "camera-web-symbolic";
        } else {
            muteIconName = isMuted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic";
        }
        muteBtn.set_child(new St.Icon({ icon_name: muteIconName, icon_size: 20 }));

        muteBtn.connect("clicked", function() {
            if (src === "cam") {
                s.setValue("cam-muted", !self._s_cam_muted);
            } else {
                s.setValue("mic-muted", !self._s_mic_muted);
            }
        });

        let muteLbl = new St.Label({
            text: src === "cam" ? "Silenciar cámara" : "Silenciar micrófono",
            style_class: "canela-hint",
            style: "text-align: center;"
        });

        muteBox.add(new St.Bin({ child: muteLbl, x_align: St.Align.MIDDLE }));
        muteBox.add(new St.Bin({ child: muteBtn, x_align: St.Align.MIDDLE }));

        muteItem.addActor(
            new St.Bin({ child: muteBox, x_fill: false, x_align: St.Align.MIDDLE }),
            { expand: true }
        );
        this.menu.addMenuItem(muteItem);
    },

    // -----------------------------------------------------------------------
    // Helper de Acordeón con Animación Suave (Tweener)
    // -----------------------------------------------------------------------

    _addAccordionRow: function(id, title, iconName, initialBadge, buildContentCb) {
        let self = this;
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });

        let container = new St.BoxLayout({
            vertical: true,
            style_class: "canela-accordion-item",
            style: "width: 304px;"
        });

        // 1. Botón de cabecera
        let header = new St.Button({
            style_class: "canela-accordion-header",
            reactive: true,
            can_focus: true
        });

        let headerRow = new St.BoxLayout({
            style: "spacing: 8px; padding: 7px 10px; width: 304px;"
        });

        let iconBadge = new St.Bin({
            child: new St.Icon({ icon_name: iconName, icon_size: 13 }),
            style_class: "canela-badge-icon-sm"
        });

        let titleLbl = new St.Label({
            text: title,
            style_class: "canela-accordion-title",
            y_align: St.Align.MIDDLE
        });

        let valBadge = new St.Label({
            text: initialBadge,
            style_class: "canela-accordion-val",
            y_align: St.Align.MIDDLE
        });

        let arrowIcon = new St.Icon({
            icon_name: this._openAccordions[id] ? "pan-down-symbolic" : "pan-end-symbolic",
            icon_size: 11,
            style_class: "canela-accordion-arrow",
            y_align: St.Align.MIDDLE
        });

        headerRow.add(iconBadge);
        headerRow.add(titleLbl, { expand: true });
        headerRow.add(valBadge);
        headerRow.add(arrowIcon);
        header.set_child(headerRow);
        container.add(header);

        // 2. Contenedor de contenido animado
        let bodyBin = new St.Bin({
            style_class: "canela-accordion-body",
            x_fill: true,
            y_fill: true,
            clip_to_allocation: true
        });

        let content = buildContentCb();
        bodyBin.set_child(content);
        container.add(bodyBin);

        if (!this._openAccordions[id]) {
            bodyBin.hide();
        }

        function doToggle() {
            let willExpand = !self._openAccordions[id];
            self._openAccordions[id] = willExpand;

            if (willExpand) {
                bodyBin.show();
                arrowIcon.set_icon_name("pan-down-symbolic");
                let [minH, natH] = content.get_preferred_height(304);
                bodyBin.set_height(0);
                bodyBin.opacity = 0;
                Tweener.addTween(bodyBin, {
                    height: natH,
                    opacity: 255,
                    time: 0.22,
                    transition: "easeOutQuad",
                    onComplete: function() {
                        bodyBin.set_height(-1);
                    }
                });
            } else {
                arrowIcon.set_icon_name("pan-end-symbolic");
                Tweener.addTween(bodyBin, {
                    height: 0,
                    opacity: 0,
                    time: 0.18,
                    transition: "easeInQuad",
                    onComplete: function() {
                        bodyBin.hide();
                    }
                });
            }
        }

        header.connect("clicked", doToggle);

        this._accordions = this._accordions || {};
        this._accordions[id] = {
            toggle: doToggle,
            body: bodyBin,
            header: header
        };

        this["_badge_" + id] = valBadge;

        item.addActor(
            new St.Bin({ child: container, x_fill: false, x_align: St.Align.MIDDLE }),
            { expand: true }
        );
        this.menu.addMenuItem(item);
    },

    _updateAccordionBadge: function(id, text) {
        if (this["_badge_" + id]) {
            this["_badge_" + id].set_text(text);
        }
    },

    _updateLightBadge: function() {
        let b = this.settings.getValue("cam-brightness");
        let c = this.settings.getValue("cam-contrast");
        this._updateAccordionBadge("cam_light", "B:" + b + "% / C:" + c + "%");
    },

    _createPillsRow: function(options, currentVal, onSelectCb, available) {
        let pillsBox = new St.BoxLayout({ style_class: "canela-pills-row" });
        for (let i = 0; i < options.length; i++) {
            let opt = options[i];
            let active = (currentVal === opt.id);
            let btn = new St.Button({
                label: opt.label,
                style_class: "canela-pill-btn" + (active ? " active" : ""),
                x_expand: true,
                reactive: available
            });
            btn.connect("clicked", function() {
                // Actualizar estilo visual activo
                let children = pillsBox.get_children();
                for (let ch of children) {
                    ch.remove_style_class_name("active");
                }
                btn.add_style_class_name("active");
                onSelectCb(opt.id);
            });
            pillsBox.add(btn, { expand: true });
        }
        return pillsBox;
    },

    _createSliderRow: function(label, key, min, max, available, onChangeCb) {
        let self = this;
        let col = new St.BoxLayout({ vertical: true, style: "padding: 2px 2px;" });
        let row = new St.BoxLayout();

        let lbl = new St.Label({ text: label, style_class: "canela-slider-label" });
        let val = new St.Label({
            text: this.settings.getValue(key) + "%",
            style_class: "canela-slider-val",
            style: "min-width: 32px; text-align: right;"
        });
        row.add(lbl, { expand: true });
        row.add(val);

        let slider = new PopupMenu.PopupSliderMenuItem(
            clamp(this.settings.getValue(key), min, max) / max
        );
        slider.actor.reactive = available;
        if (!available) slider.actor.add_style_class_name("disabled");

        slider.connect("value-changed", function(s) {
            let v = Math.round(s.value * max);
            self.settings.setValue(key, v);
            val.set_text(v + "%");
            self._syncBackend();
            if (onChangeCb) onChangeCb(v);
        });

        col.add(row);
        col.add(slider.actor);
        return col;
    },

    _toggleDelayLoopback: function() {
        if (this._delayRunning) {
            this._sendBackend({ action: "mic_delay_stop" });
        } else {
            let preset = this.settings.getValue("mic-voice-preset") || "natural";
            this._sendBackend({ action: "mic_delay_start", preset: preset });
        }
    },

    // -----------------------------------------------------------------------
    // Etiquetas de Estado
    // -----------------------------------------------------------------------

    _getBlurLabel: function(val) {
        if (val === "soft" || val === 1) return "Suave";
        if (val === "deep" || val === 2) return "Profundo";
        return "Desactivado";
    },

    _getAvatarLabel: function(val) {
        switch(val) {
            case "dog":   return "🐶 Perrito";
            case "cat":   return "🐱 Gatito";
            case "panda": return "🐼 Panda";
            case "cyber": return "🕶️ Cyber";
            default:      return "Ninguno";
        }
    },

    _getPresetLabel: function(val) {
        switch(val) {
            case "studio":    return "Estudio";
            case "radio":     return "Radio";
            case "megaphone": return "Megáfono";
            case "echo":      return "Eco";
            default:          return "Natural";
        }
    },

    _setSource: function(src) {
        this.settings.setValue("active-source", src);
        this._s_active_source = src;
        this._buildMenu();
        if (this.menu.isOpen) {
            this._activateCurrentSource();
        }
    },

    // -----------------------------------------------------------------------
    // Ciclo de Vida
    // -----------------------------------------------------------------------

    on_applet_clicked: function() {
        this.menu.toggle();
    },

    on_applet_removed_from_panel: function() {
        this._sendBackend({ action: "cam_stop" });
        this._sendBackend({ action: "mic_stop" });
        this._sendBackend({ action: "mic_delay_stop" });
        if (this._subprocess) {
            try {
                this._subprocess.force_exit();
            } catch(e) {}
        }
        this.settings.finalize();
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new CanelaApplet(metadata, orientation, panel_height, instance_id);
}
