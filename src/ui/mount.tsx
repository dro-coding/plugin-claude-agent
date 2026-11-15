/** Puts the React panel into the element the plugin host gives the panel, with its stylesheet. */
import { createRoot } from "react-dom/client";
import type { AgentController } from "../controller";
import { AgentPanel } from "./AgentPanel";
import { AGENT_CSS } from "./styles";

const STYLE_ID = "claude-agent-plugin-styles";
let mounted = 0;

export function mountAgent(body: HTMLElement, controller: AgentController): () => void {
  if (mounted++ === 0 && !document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = AGENT_CSS;
    document.head.append(style);
  }
  const root = createRoot(body);
  root.render(<AgentPanel controller={controller} />);
  return () => {
    root.unmount();
    if (--mounted === 0) document.getElementById(STYLE_ID)?.remove();
  };
}
