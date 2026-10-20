# mod-claude-code

Mods for [Claude Code](https://claude.com/claude-code) by Paolo Dalprato.

A mod is a Claude Code plugin made of a hooks module: code that runs inside Claude Code and changes its interface or behaviour, for example a panel beside the chat. This repository is a plugin marketplace, so each mod installs with one command.

## Mods

| Mod | What it does |
| --- | --- |
| [context-panel](context-panel/) | A side panel that shows what fills the context window, the usage limits and the session cost. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace paolodalprato/mod-claude-code
```

Replace `<mod>` with the name in the table. Each mod's README has the exact lines.

## Requirements

Mods use the hooks module API of Claude Code, which is in early access and can change between releases. Each mod's README states the version it was tested on.

## License

[MIT](LICENSE)
