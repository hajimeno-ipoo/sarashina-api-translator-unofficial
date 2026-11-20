import { createRoot } from "react-dom/client";
import { BorderBeam } from "border-beam";
import { ThinkingOrb } from "thinking-orbs";
import { VoiceBeam } from "voice-glow";

const radius = 16;
const bannerId = "sarashina-speech-status";
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const hostStyle = {
  all: "initial",
  boxSizing: "border-box",
  position: "fixed",
  inset: "24px 0 auto",
  width: "min(450px, calc(100% - 32px))",
  marginInline: "auto",
  display: "block",
  pointerEvents: "none",
  zIndex: "2147483647",
  borderRadius: `${radius}px`,
  background: "#202020",
  color: "#fff",
  boxShadow: "0 8px 28px #0006",
  font: "700 20px / 1.4 system-ui, sans-serif",
  colorScheme: "dark"
};
const contentStyle = {
  position: "relative",
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  boxSizing: "border-box",
  minHeight: 84,
  padding: "8px 16px"
};
const cancelStyle = {
  position: "absolute",
  top: 6,
  right: 6,
  display: "grid",
  placeItems: "center",
  width: 40,
  height: 40,
  pointerEvents: "auto",
  padding: 0,
  border: 0,
  borderRadius: 8,
  background: "transparent",
  color: "#ffffffb8",
  font: "400 22px / 1 system-ui, sans-serif",
  cursor: "pointer"
};
const captionStyle = {
  fontSize: 18,
  fontWeight: 600,
  textAlign: "center",
  textWrap: "balance",
  overflowWrap: "anywhere"
};

let current;

function Banner({ status }) {
  const preparing = status.state === "preparing";
  const canCancel = preparing && status.onCancel;
  const content = (
    <div style={canCancel ? { ...contentStyle, paddingInlineEnd: 44 } : contentStyle}>
      {preparing && (
        <ThinkingOrb
          state="working"
          size={64}
          theme="dark"
          color="#c1e4ff"
          dots={1.25}
          dotSize={1.4}
          aria-hidden="true"
          paused={motionPreference.matches}
          style={{ flex: "0 0 64px" }}
        />
      )}
      <span role="status" style={preparing ? undefined : captionStyle}>
        {preparing ? "読み上げを準備中" : status.caption}
      </span>
      {canCancel && (
        <button
          type="button"
          aria-label="読み上げを中止"
          title="読み上げを中止"
          style={cancelStyle}
          onClick={() => cancelBanner(status)}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );

  if (motionPreference.matches) return content;
  if (preparing) {
    return (
      <BorderBeam style={{ "--beam-stroke-opacity": 3, "--beam-inner-opacity": 1.75 }}>
        {content}
      </BorderBeam>
    );
  }
  return (
    <VoiceBeam type="default" theme="dark" colorVariant="ice" level={status.getLevel}
      idle={0} borderRadius={radius} distortion={0}>
      {content}
    </VoiceBeam>
  );
}

function closeBanner() {
  if (!current) return;
  current.root.unmount();
  current.host.remove();
  motionPreference.removeEventListener("change", renderBanner);
  current = undefined;
}

function cancelBanner(status) {
  if (current !== status || status.state !== "preparing") return;
  closeBanner();
  status.onCancel();
}

function renderBanner() {
  if (current) current.root.render(<Banner status={current} />);
}

function update(requestId, state, onCancel) {
  if (state === "hidden") {
    if (current?.requestId === requestId) closeBanner();
    return;
  }

  if (state === "preparing" && current?.requestId !== requestId) {
    closeBanner();
    // Reloading the extension leaves its old display in an already-open tab.
    document.getElementById(bannerId)?.remove();
    const host = document.createElement("div");
    host.id = bannerId;
    host.lang = "ja";
    Object.assign(host.style, hostStyle);
    const shadow = host.attachShadow({ mode: "open" });
    const status = { requestId, host, root: createRoot(shadow), level: 0, onCancel };
    status.getLevel = () => status.level;
    current = status;
    document.documentElement.appendChild(host);
    motionPreference.addEventListener("change", renderBanner);
  }

  if (current?.requestId !== requestId || current.state === state) return;
  current.state = state;
  current.level = 0;
  renderBanner();
}

function setLevel(requestId, level) {
  if (current?.requestId === requestId && current.state === "playing" && Number.isFinite(level)) {
    current.level = Math.max(0, Math.min(1, level));
  }
}

function showCaption(requestId, caption) {
  if (current?.requestId !== requestId || typeof caption !== "string" || !caption
      || (current.state === "playing" && current.caption === caption)) return;
  if (current.state !== "playing") current.level = 0;
  current.state = "playing";
  current.caption = caption;
  renderBanner();
}

globalThis.SarashinaSpeechStatus = { update, showCaption, setLevel };
