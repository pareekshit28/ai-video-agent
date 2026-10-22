"""Cross-platform desktop UI for the URL-only ComfyUI Codex helper."""
import argparse
from datetime import datetime
import queue
import sys
import tkinter as tk
from tkinter import ttk
import webbrowser

from pc_helper import HelperController, HelperError, VERSION, base_url, load_settings, save_settings

BG, CARD, TEXT, MUTED, ACCENT = "#111827", "#1e293b", "#f1f5f9", "#a8b7cc", "#2dd4bf"


class HelperApp:
    def __init__(self, root, auto_connect=True):
        self.root = root
        self.events = queue.Queue()
        self.controller = HelperController(lambda *event: self.events.put(event))
        self.pending_connect = None
        self.closing = False
        settings = load_settings()
        self.url = tk.StringVar(value=settings["url"])
        self.connect_on_open = tk.BooleanVar(value=settings["connectOnOpen"])
        root.title("ComfyUI Codex Helper")
        root.geometry("780x600")
        root.minsize(650, 520)
        root.configure(background=BG)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.report_callback_exception = lambda kind, error, trace: self.show("error", str(error), "")

        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure("TFrame", background=BG)
        style.configure("TLabel", background=BG, foreground=TEXT, font=("Arial", 11))
        style.configure("Muted.TLabel", foreground=MUTED)
        style.configure("Title.TLabel", font=("Arial", 25, "bold"))
        style.configure("Eyebrow.TLabel", foreground=ACCENT, font=("Arial", 10, "bold"))
        style.configure("TButton", font=("Arial", 11), padding=(16, 10), background=CARD, foreground=TEXT)
        style.map("TButton", background=[("active", "#334155")])
        style.configure("Primary.TButton", background=ACCENT, foreground=BG, font=("Arial", 11, "bold"))
        style.map("Primary.TButton", background=[("active", "#5eead4")])
        style.configure("TCheckbutton", background=BG, foreground=MUTED, font=("Arial", 10))
        style.map("TCheckbutton", background=[("active", BG)], foreground=[("active", TEXT)])
        style.configure("TEntry", fieldbackground=CARD, foreground=TEXT, insertcolor=TEXT, padding=12)

        page = ttk.Frame(root, padding=28)
        page.pack(fill="both", expand=True)
        page.columnconfigure(0, weight=1)
        page.rowconfigure(8, weight=1)
        ttk.Label(page, text="YOUR COMPUTER  ↔  YOUR COMFYUI", style="Eyebrow.TLabel").grid(row=0, sticky="w")
        ttk.Label(page, text="Codex, connected.", style="Title.TLabel").grid(row=1, sticky="w", pady=(10, 8))
        ttk.Label(page, text="Paste your pod URL. This app handles the connection.", style="Muted.TLabel").grid(row=2, sticky="w", pady=(0, 24))

        ttk.Label(page, text="ComfyUI URL").grid(row=3, sticky="w", pady=(0, 8))
        connection = ttk.Frame(page)
        connection.grid(row=4, sticky="ew")
        connection.columnconfigure(0, weight=1)
        self.entry = ttk.Entry(connection, textvariable=self.url, font=("Arial", 11))
        self.entry.grid(row=0, column=0, sticky="ew", padx=(0, 10))
        self.entry.bind("<Return>", lambda event: self.connect())
        self.connect_button = ttk.Button(connection, text="Connect", command=self.connect, style="Primary.TButton")
        self.connect_button.grid(row=0, column=1)
        self.url.trace_add("write", self.url_changed)

        controls = ttk.Frame(page)
        controls.grid(row=5, sticky="ew", pady=(12, 20))
        ttk.Checkbutton(controls, text="Connect when this app opens", variable=self.connect_on_open, command=self.remember).pack(side="left")
        ttk.Button(controls, text="Open ComfyUI", command=self.open_comfyui).pack(side="right")
        ttk.Button(controls, text="Disconnect", command=self.disconnect).pack(side="right", padx=8)

        status_card = tk.Frame(page, bg=CARD, padx=18, pady=16)
        status_card.grid(row=6, sticky="ew")
        self.status_title = tk.Label(status_card, text="●  Disconnected", bg=CARD, fg=MUTED, font=("Arial", 14, "bold"), anchor="w")
        self.status_title.pack(fill="x")
        self.status_detail = tk.Label(status_card, text="Paste your HTTPS ComfyUI URL above to get started.", bg=CARD, fg=TEXT, font=("Arial", 11), anchor="w", justify="left", wraplength=640)
        self.status_detail.pack(fill="x", pady=(8, 0))
        self.active_url = tk.Label(status_card, text="", bg=CARD, fg=MUTED, font=("Arial", 9), anchor="w")
        self.active_url.pack(fill="x", pady=(6, 0))

        ttk.Label(page, text="ACTIVITY", style="Eyebrow.TLabel").grid(row=7, sticky="w", pady=(22, 8))
        self.activity = tk.Text(page, height=5, bg=CARD, fg=MUTED, relief="flat", font=("Arial", 10), padx=12, pady=10,
                                wrap="word", state="disabled", highlightthickness=0)
        self.activity.grid(row=8, sticky="nsew")
        ttk.Label(page, text=f"v{VERSION}  ·  Keep this app open while planning. Your Codex login stays on this computer.", style="Muted.TLabel", wraplength=700).grid(row=9, sticky="w", pady=(16, 0))
        self.last_activity = None
        self.root.after(100, self.poll)
        if auto_connect and settings["url"] and settings["connectOnOpen"]:
            self.root.after(250, self.connect)

    def url_changed(self, *args):
        if self.pending_connect:
            self.root.after_cancel(self.pending_connect)
        # Pasting a replacement URL switches pods without another setup step.
        self.pending_connect = self.root.after(1200, self.auto_connect)

    def auto_connect(self):
        self.pending_connect = None
        try:
            base_url(self.url.get())
        except HelperError:
            return
        self.connect()

    def remember(self):
        try:
            save_settings(self.url.get(), self.connect_on_open.get())
        except HelperError:
            pass

    def connect(self):
        if self.pending_connect:
            self.root.after_cancel(self.pending_connect)
            self.pending_connect = None
        try:
            url = base_url(self.url.get())
            save_settings(url, self.connect_on_open.get())
            self.controller.connect(url)
        except (HelperError, OSError) as error:
            self.show("error", str(error), "")

    def disconnect(self):
        if self.pending_connect:
            self.root.after_cancel(self.pending_connect)
            self.pending_connect = None
        self.controller.disconnect()

    def open_comfyui(self):
        try:
            webbrowser.open(base_url(self.url.get()))
        except HelperError as error:
            self.show("error", str(error), "")

    def poll(self):
        if self.closing:
            if not self.controller.thread.is_alive():
                self.root.destroy()
                return
        try:
            while True:
                self.show(*self.events.get_nowait())
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def show(self, state, message, url):
        if state != "activity":
            title = {"checking": "Checking Codex", "connecting": "Connecting", "reconnecting": "Reconnecting",
                     "connected": "Connected", "planning": "Planning", "disconnected": "Disconnected", "error": "Needs attention"}.get(state, state.title())
            color = ACCENT if state == "connected" else "#f87171" if state == "error" else "#fbbf24" if state in ("reconnecting", "planning") else MUTED
            self.status_title.configure(text="●  " + title, fg=color)
            self.status_detail.configure(text=message)
            self.active_url.configure(text=url)
        if self.last_activity != message:
            self.last_activity = message
            self.activity.configure(state="normal")
            self.activity.insert("end", datetime.now().strftime("%H:%M:%S") + "  " + message + "\n")
            if int(self.activity.index("end-1c").split(".")[0]) > 120:
                self.activity.delete("1.0", "30.0")
            self.activity.see("end")
            self.activity.configure(state="disabled")

    def close(self):
        self.closing = True
        self.disconnect()
        self.controller.close()
        self.connect_button.configure(state="disabled")
        self.status_title.configure(text="●  Closing")
        self.status_detail.configure(text="Disconnecting and closing any active Codex planning request…")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    root = tk.Tk()
    app = HelperApp(root, auto_connect=not args.smoke_test)
    if args.smoke_test:
        root.update()
        assert app.entry.winfo_exists() and app.connect_button.cget("text") == "Connect"
        app.controller.close()
        app.controller.thread.join(timeout=2)
        root.destroy()
        return
    root.mainloop()


if __name__ == "__main__":
    main()
