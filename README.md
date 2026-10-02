# NETRUNNER//HUD

A cyberpunk dashboard for your Claude Code session, drawn in the terminal and animated at 30 fps.

`/hud` opens a pane with:

- **Header:** an uplink clock, context fill, session cost and live token rate, with a magenta-to-cyan sweep, a scanline and the occasional katakana glitch.
- **Context gauge:** a braille semicircle that runs green → amber → red as the context window fills, with a breathing needle.
- **Token flux oscilloscope:** a scrolling braille waveform of Claude's output rate (text, thinking and tool input), estimated at about four characters per token over real elapsed time. It only counts while the HUD is open. Older trace fades like phosphor.
- **Tool waterfall:** every tool call as a coloured bar (Bash green, edits amber, reads cyan, web violet, subagents magenta), its length on a log scale of duration, red when it failed. Subagent calls are marked `↳`.
- **Widgets:** background jobs Claude started (removed when the task's completion notice arrives or it's stopped), git branch and dirty count (`status unknown` if git fails, never a false `clean`), the last test run (`PASS`/`FAIL` when the command was a plain test run, `?` when the runner was only part of a compound command), and session cost with burn rate.

Run `/hud` again to close it. The animation only runs while the pane is open.

It needs a terminal surface. On the desktop app, or in a pane narrower than 60 columns, it shows a compact text summary instead of the rasters and the animation stops. A wide terminal docks it beside the transcript; a narrow one opens it inline. Usage and git refresh on their own slow timers, so a slow repository never stalls a frame.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install netrunner-hud@ccdwyer-mods
/reload-plugins
```

## What it hooks

- `session.start`: registers `/hud`, and restarts the animation if the pane survived a reload
- `session.end`: stops the animation
- `command.run{command=hud}`: opens or closes the pane (it adds nothing to the transcript)
- `ui.close{id=netrunner-hud}`: stops the animation when the pane closes
- `turn.step`: counts streamed characters for the oscilloscope; every chunk, the stream's result, and an interrupt pass straight through to the stream beneath
- `prompt.submit`: on a background task's notification, removes that job from the widget; the prompt itself passes unchanged
- `tool.call`: records each call's tool, a short label, duration and outcome, and passes the result through unchanged
- `ui.render{component=Pane}`: draws the dashboard

Engine calls it makes: `$.ui.open`, `$.ui.close`, `$.ui.panes`, `$.ui.blit`, `$.clock.every`, `$.session.usage`, `$.session.cwd`, `$.process.run` (`git rev-parse`, `git status`, with the repository's `status` alias and fsmonitor disabled), `$.ui.toast`, `$.state`.

## Privacy

It runs entirely on your machine and sends nothing over the network. It reads the session's own usage figures and runs `git` locally while the HUD is open.

Full policy: [PRIVACY.md](PRIVACY.md).

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT
