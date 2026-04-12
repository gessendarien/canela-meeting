const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const UUID = "canela@canela";
const APPLET_DIR = imports.ui.appletManager.appletMeta[UUID].path;

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

// ---------------------------------------------------------------------------
// Main Applet
// ---------------------------------------------------------------------------

function CanelaApplet(metadata, orientation, panelHeight, instanceId) {
    this._init(metadata, orientation, panelHeight, instanceId);
}

CanelaApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(metadata, orientation, panelHeight, instanceId) {
        Applet.IconApplet.prototype._init.call(this, orientation, panelHeight, instanceId);

        this.set_applet_icon_symbolic_name("camera-web");
        this.set_applet_tooltip("Canela — Cam & Mic settings");

        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        this._bindSettings();

        this._source      = this.settings.getValue("active-source") || "cam";
        this._sessionType = "x11";
        this._camAvailable = false;
        this._micAvailable = false;

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._buildMenu();

        this._startBackend();
    },

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    _bindSettings: function() {
        let keys = [
            "active-source",
            "accent-color", "preview-bg-color",
            "cam-brightness", "cam-contrast", "cam-blur", "cam-mode", "cam-muted",
            "mic-range", "mic-gain", "mic-reverb", "mic-noise-reduction", "mic-muted"
        ];
        keys.forEach(k => {
            this.settings.bindProperty(
                Settings.BindingDirection.BIDIRECTIONAL,
                k, "_s_" + k.replace(/-/g, "_"),
                this._onSettingChanged.bind(this), null
            );
        });
    },

    _onSettingChanged: function() {
        this._syncBackend();
        this._buildMenu();
    },

    // helpers to read colours with fallback
    _accentColor: function() {
        return this._s_accent_color || "rgba(216,90,48,1)";
    },
    _previewBgColor: function() {
        return this._s_preview_bg_color || "rgba(100,100,100,0.18)";
    },

    // -----------------------------------------------------------------------
    // Backend process
    // -----------------------------------------------------------------------

    _startBackend: function() {
        try {
            let [ok, pid, stdin_fd, stdout_fd] = GLib.spawn_async_with_pipes(
                APPLET_DIR,
                ["/usr/bin/python3", APPLET_DIR + "/backend.py"],
                null,
                GLib.SpawnFlags.DO_NOT_REAP_CHILD | GLib.SpawnFlags.SEARCH_PATH,
                null
            );

            this._backendStdin  = new Gio.DataOutputStream({
                base_stream: new Gio.UnixOutputStream({ fd: stdin_fd, close_fd: true })
            });
            this._backendStdout = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({ fd: stdout_fd, close_fd: true })
            });
            this._backendPid = pid;

            this._readBackendLine();

        } catch(e) {
            global.logError("[Canela] Failed to start backend: " + e.message);
        }
    },

    _readBackendLine: function() {
        if (!this._backendStdout) return;

        this._backendStdout.read_line_async(
            GLib.PRIORITY_DEFAULT, null,
            (stream, result) => {
                try {
                    let [line] = stream.read_line_finish_utf8(result);
                    if (line) {
                        this._handleBackendMsg(JSON.parse(line));
                    }
                } catch(e) {
                    // log but keep reading
                    global.logError("[Canela] parse error: " + e.message);
                }
                // Always schedule the next read
                this._readBackendLine();
            }
        );
    },

    _handleBackendMsg: function(msg) {
        if (msg.action === "hw_status") {
            let wasUnavailable = !this._camAvailable;
            this._camAvailable = msg.cam;
            this._micAvailable = msg.mic;

            if (msg.cam && wasUnavailable) {
                // Camera just appeared — start stream
                this._syncBackend();
            }
            this._buildMenu();
        }

        if (msg.status === "ready") {
            this._syncBackend();
        }

        if (msg.session) {
            this._sessionType = msg.session;
            this.set_applet_tooltip(
                "Canela — Cam & Mic\nSession: " + msg.session.toUpperCase()
            );
        }
    },

    _sendBackend: function(obj) {
        if (!this._backendStdin) return;
        try {
            this._backendStdin.put_string(JSON.stringify(obj) + "\n", null);
        } catch(e) {
            global.logError("[Canela] Write error: " + e.message);
        }
    },

    _syncBackend: function() {
        let s = this.settings;
        if (this._s_cam_muted) {
            this._sendBackend({ action: "cam_stop" });
        } else {
            this._sendBackend({
                action:     "cam_update",
                brightness: s.getValue("cam-brightness"),
                contrast:   s.getValue("cam-contrast"),
                blur:       s.getValue("cam-blur")
            });
        }
        if (this._s_mic_muted) {
            this._sendBackend({ action: "mic_stop" });
        } else {
            this._sendBackend({
                action:          "mic_update",
                gain:            s.getValue("mic-gain"),
                reverb:          s.getValue("mic-reverb"),
                noise_reduction: s.getValue("mic-noise-reduction"),
                mic_range:       s.getValue("mic-range")
            });
        }
    },

    _stopBackend: function() {
        if (this._backendStdin) {
            this._sendBackend({ action: "quit" });
            this._backendStdin  = null;
            this._backendStdout = null;
        }
    },

    // -----------------------------------------------------------------------
    // Menu — design.html layout
    // -----------------------------------------------------------------------

    _buildMenu: function() {
        this.menu.removeAll();

        let accent   = this._accentColor();
        let previewBg = this._previewBgColor();
        let available = this._source === "cam" ? this._camAvailable : this._micAvailable;

        // ── TITLE ─────────────────────────────────────────────────────────
        let titleItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let titleLbl  = new St.Label({ text: "CANELA", style_class: "canela-title" });
        titleItem.addActor(
            new St.Bin({ child: titleLbl, x_fill: true, x_align: St.Align.MIDDLE }),
            { expand: true }
        );
        this.menu.addMenuItem(titleItem);

        // ── SOURCE TOGGLE (round icon buttons) ────────────────────────────
        let topItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let topBox  = new St.BoxLayout({ style_class: "canela-top-btns" });

        let camActiveStyle = this._source === "cam"
            ? `background-color:${accent}; border-color:${accent};`
            : "";
        let micActiveStyle = this._source === "mic"
            ? `background-color:${accent}; border-color:${accent};`
            : "";

        let camBtn = new St.Button({
            style_class: "canela-top-btn" + (this._source === "cam" ? " active" : ""),
            style: camActiveStyle,
            reactive: true
        });
        camBtn.set_child(new St.Icon({ icon_name: "camera-web-symbolic", icon_size: 20 }));
        camBtn.connect("clicked", () => this._setSource("cam"));

        let micBtn = new St.Button({
            style_class: "canela-top-btn" + (this._source === "mic" ? " active" : ""),
            style: micActiveStyle,
            reactive: true
        });
        micBtn.set_child(new St.Icon({ icon_name: "audio-input-microphone-symbolic", icon_size: 20 }));
        micBtn.connect("clicked", () => this._setSource("mic"));

        topBox.add(camBtn);
        topBox.add(micBtn);
        topItem.addActor(
            new St.Bin({ child: topBox, x_fill: false, x_align: St.Align.MIDDLE }),
            { expand: true }
        );
        this.menu.addMenuItem(topItem);

        // ── PREVIEW AREA ──────────────────────────────────────────────────
        let previewItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let previewBox  = new St.BoxLayout({
            vertical: true,
            style: `height: 148px; border-radius: 16px; background-color: ${previewBg};` +
                   " border: 1px solid rgba(128,128,128,0.25); margin: 4px 12px 8px; padding: 8px;"
        });

        if (this._source === "cam") {
            if (this._camAvailable) {
                // LIVE badge
                let liveRow   = new St.BoxLayout();
                let liveBadge = new St.BoxLayout({
                    style: "background-color:rgba(0,0,0,0.6);padding:3px 10px;border-radius:999px;"
                });
                liveBadge.add(new St.Widget({
                    style: "width:7px;height:7px;border-radius:4px;background-color:#e03a2f;"
                }));
                liveBadge.add(new St.Label({
                    text: "LIVE",
                    style: "font-size:11px;font-weight:700;color:#fff;margin-left:4px;"
                }));
                liveRow.add(liveBadge);
                previewBox.add(liveRow);

                // Person icon centred
                let personBin = new St.Bin({
                    x_fill: true, y_fill: true,
                    x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE
                });
                personBin.set_child(new St.Icon({
                    icon_name: "avatar-default-symbolic",
                    icon_size: 36,
                    style: "color:rgba(128,128,128,0.5);"
                }));
                previewBox.add(personBin, { expand: true });

            } else {
                // Cam not found → single centred refresh button
                let bin = new St.Bin({
                    x_fill: true, y_fill: true,
                    x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE
                });
                let btn = new St.Button({
                    style: `border-radius:22px;padding:12px;background-color:${accent};border:none;`,
                    reactive: true
                });
                btn.set_child(new St.Icon({
                    icon_name: "view-refresh-symbolic",
                    icon_size: 22,
                    style: "color:#ffffff;"
                }));
                btn.connect("clicked", () => { this._sendBackend({ action: "hw_check" }); });
                bin.set_child(btn);
                previewBox.add(bin, { expand: true });
            }

        } else {
            // ── MIC mode — no LIVE badge ────────────────────────────────
            if (!this._micAvailable) {
                // Mic not found → single centred refresh button
                let bin = new St.Bin({
                    x_fill: true, y_fill: true,
                    x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE
                });
                let btn = new St.Button({
                    style: `border-radius:22px;padding:12px;background-color:${accent};border:none;`,
                    reactive: true
                });
                btn.set_child(new St.Icon({
                    icon_name: "view-refresh-symbolic",
                    icon_size: 22,
                    style: "color:#ffffff;"
                }));
                btn.connect("clicked", () => { this._sendBackend({ action: "hw_check" }); });
                bin.set_child(btn);
                previewBox.add(bin, { expand: true });

            } else {
                // Mic available — centred mic icon
                let bin = new St.Bin({
                    x_fill: true, y_fill: true,
                    x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE
                });
                bin.set_child(new St.Icon({
                    icon_name: "audio-input-microphone-symbolic",
                    icon_size: 48,
                    style: "color:rgba(128,128,128,0.5);"
                }));
                previewBox.add(bin, { expand: true });
            }
        }

        previewItem.addActor(previewBox, { expand: true });
        this.menu.addMenuItem(previewItem);

        // ── SLIDERS ───────────────────────────────────────────────────────
        if (this._source === "cam") {
            this._addSlider("BRILLO",     "cam-brightness", 0, 100, this._camAvailable, accent);
            this._addSlider("CONTRASTE",  "cam-contrast",   0, 100, this._camAvailable, accent);
            this._addSlider("DESENFOQUE", "cam-blur",       0, 100, this._camAvailable, accent);
        } else {
            this._addSlider("ALCANCE",            "mic-range",           0, 100, this._micAvailable, accent);
            this._addSlider("GANANCIA",           "mic-gain",            0, 100, this._micAvailable, accent);
            this._addSlider("REVERBERACIÓN",      "mic-reverb",          0, 100, this._micAvailable, accent);
            this._addSlider("REDUCCIÓN DE RUIDO", "mic-noise-reduction", 0, 100, this._micAvailable, accent);
        }

        // ── PORTRAIT / LANDSCAPE (camera only) ────────────────────────────
        if (this._source === "cam") {
            let modeItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            let modeBox  = new St.BoxLayout({ style_class: "canela-modes" });
            let s = this.settings;
            let isCamMode = (m) => s.getValue("cam-mode") === m;

            ["portrait", "landscape"].forEach(mode => {
                let active = isCamMode(mode);
                let btn = new St.Button({
                    label: mode.charAt(0).toUpperCase() + mode.slice(1),
                    style_class: "canela-mode-btn",
                    style: active ? `background-color:${accent}; color:#fff; border-radius:999px;` : "",
                    x_expand: true,
                    reactive: this._camAvailable
                });
                if (!this._camAvailable) btn.add_style_class_name("disabled");
                btn.connect("clicked", () => {
                    s.setValue("cam-mode", mode);
                    this._buildMenu();
                });
                modeBox.add(btn, { expand: true });
            });

            modeItem.addActor(modeBox, { expand: true });
            this.menu.addMenuItem(modeItem);
        }

        // ── HINT ──────────────────────────────────────────────────────────
        let key   = this._source === "cam" ? "cam-muted" : "mic-muted";
        let muted = this.settings.getValue(key);
        let hintText = !available
            ? ""
            : muted
                ? "Activar "   + (this._source === "cam" ? "cámara" : "micrófono")
                : "Desactivar " + (this._source === "cam" ? "cámara" : "micrófono");

        if (hintText) {
            let hintItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            let hintLbl  = new St.Label({ text: hintText, style_class: "canela-hint" });
            hintItem.addActor(
                new St.Bin({ child: hintLbl, x_fill: true, x_align: St.Align.MIDDLE }),
                { expand: true }
            );
            this.menu.addMenuItem(hintItem);
        }

        // ── MUTE TOGGLE BUTTON (cam/mic icon, white=on, red=off) ─────────
        let muteItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });

        // Choose the right icon
        let muteIcon;
        if (this._source === "cam") {
            muteIcon = muted ? "camera-disabled-symbolic" : "camera-web-symbolic";
        } else {
            muteIcon = muted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic";
        }

        let muteColor = muted ? "#e03a2f" : "#ffffff";
        let muteBg    = available
            ? (muted ? "rgba(224,58,47,0.15)" : "rgba(255,255,255,0.12)")
            : "rgba(128,128,128,0.2)";

        let muteBtn = new St.Button({
            style: `border-radius:26px; width:52px; height:52px; padding:14px; border:none; background-color:${muteBg};`,
            reactive: available
        });
        muteBtn.set_child(new St.Icon({
            icon_name: muteIcon,
            icon_size: 24,
            style: `color:${muteColor};`
        }));
        muteBtn.connect("clicked", () => {
            this.settings.setValue(key, !muted);
            this._syncBackend();
            this._buildMenu();
        });
        muteItem.addActor(
            new St.Bin({ child: muteBtn, x_fill: false, x_align: St.Align.MIDDLE }),
            { expand: true }
        );
        this.menu.addMenuItem(muteItem);

        // ── FOOTER ────────────────────────────────────────────────────────
        let footerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let footerLbl  = new St.Label({
            text: "CANELA ENGINE V0.4.3 OSSIDIAN",
            style_class: "canela-footer"
        });
        footerItem.addActor(
            new St.Bin({ child: footerLbl, x_fill: true, x_align: St.Align.MIDDLE }),
            { expand: true }
        );
        this.menu.addMenuItem(footerItem);
    },

    _setSource: function(src) {
        this._source = src;
        this.settings.setValue("active-source", src);
        this._buildMenu();
    },

    // -----------------------------------------------------------------------
    // Slider
    // -----------------------------------------------------------------------

    _addSlider: function(label, key, min, max, available, accent) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let box  = new St.BoxLayout({
            vertical: true,
            style: "padding: 4px 14px;",
            opacity: available ? 255 : 80
        });

        let row = new St.BoxLayout();
        let lbl = new St.Label({
            text: available ? label : label + "  ✕",
            style: "font-size:11.5px; font-weight:700; letter-spacing:1px;" +
                   (available ? "" : " color:#e74c3c;")
        });
        let val = new St.Label({
            text: this.settings.getValue(key) + "%",
            style: "font-size:11.5px; min-width:38px; text-align:right;"
        });
        row.add(lbl, { expand: true });
        row.add(val);

        let slider = new PopupMenu.PopupSliderMenuItem(
            clamp(this.settings.getValue(key), min, max) / max
        );
        slider.actor.reactive = available;
        if (!available) slider.actor.add_style_class_name("disabled");

        slider.connect("value-changed", (s) => {
            let v = Math.round(s.value * max);
            this.settings.setValue(key, v);
            val.set_text(v + "%");
            this._syncBackend();
        });

        box.add(row);
        box.add(slider.actor, { expand: true });
        item.addActor(box, { expand: true });
        this.menu.addMenuItem(item);
    },

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    on_applet_clicked: function() {
        this.menu.toggle();
    },

    on_applet_removed_from_panel: function() {
        this._stopBackend();
        this.settings.finalize();
    }
};

function main(metadata, orientation, panelHeight, instanceId) {
    return new CanelaApplet(metadata, orientation, panelHeight, instanceId);
}
