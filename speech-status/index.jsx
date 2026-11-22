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
  width: "100%",
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
  pointerEvents: "auto",
  touchAction: "none",
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

function LoadingOrb({ size = 64 }) {
  return (
    <ThinkingOrb
      state="working"
      size={size}
      theme="dark"
      color="#c1e4ff"
      dots={1.25}
      dotSize={1.4}
      aria-hidden="true"
      paused={motionPreference.matches}
      style={{ flex: `0 0 ${size}px` }}
    />
  );
}

const beamLight = { "--beam-stroke-opacity": 3, "--beam-inner-opacity": 1.75 };

function mountLoading(element, { size = 64, beam = false } = {}) {
  const root = createRoot(element);
  const render = () => root.render(
    <>
      <LoadingOrb size={size} />
      {beam && !motionPreference.matches && (
        <BorderBeam borderRadius={radius} style={{ ...beamLight, position: "absolute", inset: 0, pointerEvents: "none" }} />
      )}
    </>
  );
  motionPreference.addEventListener("change", render);
  render();
  return () => {
    motionPreference.removeEventListener("change", render);
    root.unmount();
  };
}

let statusStack;

function createStatusStack() {
  const id = "sarashina-status-stack";
  document.getElementById(id)?.remove();
  const stack = document.createElement("div");
  stack.id = id;
  Object.assign(stack.style, {
    all: "initial",
    position: "fixed",
    inset: "24px 0 auto",
    width: "min(450px, calc(100% - 32px))",
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    cursor: "grab",
    pointerEvents: "none",
    zIndex: "2147483647"
  });

  let position;
  let drag;
  function positionStack(x, y) {
    const viewport = document.documentElement;
    const maxX = Math.max(12, viewport.clientWidth - stack.offsetWidth - 12);
    const maxY = Math.max(12, viewport.clientHeight - stack.offsetHeight - 12);
    position = { x: Math.min(maxX, Math.max(12, x)), y: Math.min(maxY, Math.max(12, y)) };
    stack.style.inset = `${position.y}px auto auto ${position.x}px`;
    stack.style.marginInline = "0";
  }
  function refreshPosition() {
    if (stack.firstElementChild && position) positionStack(position.x, position.y);
  }
  const interactive = "button, a[href], input, select, textarea, [contenteditable], [data-sarashina-no-drag]";
  stack.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    if (event.composedPath().some(node => node instanceof Element && node.matches(interactive))) return;
    const bounds = stack.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    stack.setPointerCapture(event.pointerId);
    stack.style.cursor = "grabbing";
    event.preventDefault();
  };
  stack.onpointermove = event => {
    if (event.pointerId !== drag?.id) return;
    positionStack(event.clientX - drag.x, event.clientY - drag.y);
  };
  stack.onlostpointercapture = () => {
    drag = undefined;
    stack.style.cursor = "grab";
  };
  const offsets = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
  stack.onkeydown = event => {
    if (event.target.parentNode !== stack || event.composedPath()[0] !== event.target) return;
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const { left, top } = stack.getBoundingClientRect();
    positionStack(left + offset[0], top + offset[1]);
  };

  new ResizeObserver(refreshPosition).observe(stack);
  window.addEventListener("resize", refreshPosition);
  document.documentElement.appendChild(stack);
  return stack;
}

function placeBar(host) {
  if (!statusStack?.isConnected) statusStack = createStatusStack();
  host.dataset.sarashinaStacked = "";
  host.tabIndex = 0;
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "帯を移動");
  // CSS injected before an extension reload can still target the old fixed bar.
  for (const [name, value] of Object.entries({
    position: "relative", inset: "auto", width: "100%", "max-width": "100%", margin: "0",
    "box-sizing": "border-box", cursor: "inherit"
  })) {
    host.style.setProperty(name, value, "important");
  }
  statusStack.appendChild(host);
}

function installStyles(shadow, css) {
  if ("adoptedStyleSheets" in shadow && typeof globalThis.CSSStyleSheet?.prototype.replaceSync === "function") {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  } else {
    const style = document.createElement("style");
    style.textContent = css;
    shadow.append(style);
  }
}

function Banner({ status }) {
  const preparing = status.state === "preparing";
  const canCancel = preparing && status.onCancel;
  const content = (
    <div style={canCancel ? { ...contentStyle, paddingInlineEnd: 44 } : contentStyle}>
      {preparing && <LoadingOrb />}
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
      <BorderBeam style={beamLight}>
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
    placeBar(host);
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
globalThis.SarashinaFeedback = { mountLoading, placeBar, installStyles };
