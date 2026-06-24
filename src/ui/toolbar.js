/*
 * Transport toolbar: wires Run/Pause/Step/Reset buttons to actions and keeps
 * their enabled state in sync with engine state.
 */
import { EV } from "../core/events.js";
import { icon } from "./icons.js";
import { $ } from "./dom.js";

export function bindTransport(actions, bus) {
    const btn = {
        run: $("btn-run"),
        stepIn: $("btn-stepin"),
        stepOver: $("btn-stepover"),
        stepOut: $("btn-stepout"),
        reset: $("btn-reset"),
    };
    let running = false;

    // One amber button toggles Run/Pause: it runs while stopped and pauses
    // while running (so there's no separate Pause button).
    btn.run.onclick = () => (running ? actions.pause() : actions.run());
    btn.stepIn.onclick = () => actions.stepIn();
    btn.stepOver.onclick = () => actions.stepOver();
    btn.stepOut.onclick = () => actions.stepOut();
    btn.reset.onclick = () => actions.reset();

    function setState(state) {
        running = state === "running";
        const idle = state === "uninit";
        const ended = state === "exited";
        btn.run.disabled = idle; // stays enabled while running so it can pause
        btn.stepIn.disabled = running || idle || ended;
        btn.stepOver.disabled = running || idle || ended;
        btn.stepOut.disabled = running || idle || ended;
        btn.reset.disabled = idle;

        // Running: bare Pause glyph; otherwise the Run icon + label.
        btn.run.classList.toggle("icon-only", running);
        btn.run.innerHTML = running ? icon("debug-pause") : icon("debug-start") + " Run";
        btn.run.title = running ? "Pause" : "Run (F5)";
    }

    bus.on(EV.STATE, ({ state }) => setState(state));
    bus.on(EV.ENGINE_READY, () => setState("paused"));
    setState("uninit");
}
