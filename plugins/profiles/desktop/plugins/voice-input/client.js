window.__ModuleLoader__.load({
  id: "dsh-voice-input",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var ROUTE = "/dsh-voice/transcribe";
    var SLOT = "conversation.input.left";

    function pickMime() {
      var list = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
      try {
        if (!window.MediaRecorder) return "";
        for (var i = 0; i < list.length; i++) {
          if (MediaRecorder.isTypeSupported(list[i])) return list[i];
        }
      } catch (e) { /* игнорируем */ }
      return "";
    }

    function bytesToBase64(bytes) {
      var out = "";
      var step = 0x8000;
      for (var i = 0; i < bytes.length; i += step) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
      }
      return btoa(out);
    }

    // Отправляем запись на host-половину и получаем распознанный текст.
    function transcribe(blob) {
      return blob.arrayBuffer().then(function (buf) {
        var body = JSON.stringify({ audio: bytesToBase64(new Uint8Array(buf)), mime: blob.type || "audio/webm" });
        return fetch(ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body,
        });
      }).then(function (res) {
        return res.json().catch(function () {
          return { ok: false, error: "HTTP " + res.status };
        });
      });
    }

    var btn = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
      height: 26,
      minWidth: 26,
      padding: "0 4px",
      border: "1px solid transparent",
      borderRadius: 6,
      background: "transparent",
      color: "inherit",
      font: "inherit",
      fontSize: 14,
      lineHeight: 1,
      cursor: "pointer",
      opacity: 0.75,
    };

    function MicButton(props) {
      var inputActions = props.inputActions;
      var useInput = props.useInput;

      var draft = useInput ? useInput(function (s) { return (s && s.draft) || ""; }) : "";
      var draftRef = React.useRef(draft);
      draftRef.current = draft;

      var stateRef = React.useRef("idle");
      var recRef = React.useRef(null);
      var chunksRef = React.useRef([]);
      var streamRef = React.useRef(null);

      var _useState = React.useState("idle");
      var state = _useState[0];
      var setState = _useState[1];
      var _note = React.useState("");
      var note = _note[0];
      var setNote = _note[1];
      var _sec = React.useState(0);
      var seconds = _sec[0];
      var setSeconds = _sec[1];
      var _hov = React.useState(false);
      var hover = _hov[0];
      var setHover = _hov[1];

      function go(next) {
        stateRef.current = next;
        setState(next);
      }

      function release() {
        var s = streamRef.current;
        streamRef.current = null;
        if (s) {
          try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* игнорируем */ }
        }
      }

      React.useEffect(function () {
        if (state !== "rec") return undefined;
        var startedAt = Date.now();
        setSeconds(0);
        var timer = setInterval(function () {
          var el = Math.floor((Date.now() - startedAt) / 1000);
          setSeconds(el);
          if (el >= 300) {
            try { if (recRef.current) recRef.current.stop(); } catch (e) { /* игнорируем */ }
          }
        }, 500);
        return function () { clearInterval(timer); };
      }, [state]);

      React.useEffect(function () { return function () { release(); }; }, []);

      function finish() {
        var blob = new Blob(chunksRef.current, {
          type: (recRef.current && recRef.current.mimeType) || "audio/webm",
        });
        chunksRef.current = [];
        recRef.current = null;
        release();
        if (!blob.size) { go("idle"); return; }
        go("busy");
        setNote("");
        transcribe(blob).then(function (data) {
          if (data && data.ok && data.text) {
            var cur = draftRef.current || "";
            var sep = cur && !/\s$/.test(cur) ? " " : "";
            if (inputActions && typeof inputActions.setDraft === "function") {
              inputActions.setDraft(cur + sep + data.text);
            }
          } else {
            setNote((data && data.error) || "не удалось распознать");
          }
        }).catch(function (e) {
          setNote("ошибка: " + ((e && e.message) || e));
        }).then(function () {
          go("idle");
        });
      }

      function toggle() {
        if (stateRef.current === "rec") {
          try { if (recRef.current) recRef.current.stop(); } catch (e) { /* игнорируем */ }
          return;
        }
        if (stateRef.current === "busy") return;
        setNote("");
        var md = navigator.mediaDevices;
        if (!md || typeof md.getUserMedia !== "function") {
          setNote("микрофон недоступен в этом окне");
          return;
        }
        md.getUserMedia({ audio: true }).then(function (stream) {
          streamRef.current = stream;
          var mime = pickMime();
          var rec;
          try {
            rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
          } catch (e) {
            setNote("MediaRecorder недоступен");
            release();
            return;
          }
          chunksRef.current = [];
          rec.ondataavailable = function (ev) {
            if (ev.data && ev.data.size) chunksRef.current.push(ev.data);
          };
          rec.onstop = function () { finish(); };
          rec.onerror = function () { setNote("сбой записи"); release(); go("idle"); };
          recRef.current = rec;
          try { rec.start(); } catch (e) { setNote("не удалось начать запись"); release(); go("idle"); return; }
          go("rec");
        }).catch(function (e) {
          var name = (e && e.name) || "";
          if (name === "NotAllowedError" || name === "SecurityError") setNote("нет разрешения на микрофон");
          else if (name === "NotFoundError") setNote("микрофон не найден");
          else setNote("микрофон: " + (name || (e && e.message) || "ошибка"));
        });
      }

      var icon = state === "rec" ? "⏺" : (state === "busy" ? "⏳" : (note ? "⚠️" : "🎤"));
      var title = state === "rec"
        ? "Остановить запись (" + seconds + " с)"
        : state === "busy"
          ? "Распознаю…"
          : note
            ? "Голос: " + note
            : "Записать голосовое (речь распознается локально)";

      var style = Object.assign({}, btn, {
        opacity: hover ? 1 : 0.75,
        color: state === "rec" ? "#e5484d" : (note ? "#e5a00d" : "inherit"),
        borderColor: hover ? "currentColor" : "transparent",
      });

      return React.createElement("button", {
        type: "button",
        title: title,
        "aria-label": title,
        onClick: toggle,
        onMouseEnter: function () { setHover(true); },
        onMouseLeave: function () { setHover(false); },
        style: style,
      }, React.createElement("span", null, icon), state === "rec" ? React.createElement("span", { style: { fontSize: 11 } }, seconds + "с") : null);
    }

    var inject = ["slots"];

    function apply(ctx) {
      try {
        ctx.slots.inject(SLOT, function () {
          return ctx.slots.register({ name: SLOT, id: "voice-input", order: 60, label: "Голос" }, MicButton);
        });
      } catch (e) {
        console.error("[voice-input] не удалось зарегистрировать кнопку в", SLOT, e);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
