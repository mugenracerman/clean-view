# Clean View

A Claude Code mod that makes Claude Code calm and friendly for people who aren't technical.

While Claude works, tool calls, file diffs and command output are hidden. Instead, one simple checklist sits above the prompt so you can always see the plan, what's happening now and how far along it is:

```
╭──────────────────────────────────────────────────────────────╮
│ ✳ Build my landing page                               1m 12s │
│ Step 2 of 4 ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░   40% │
│ ✓ Read your brand notes          ██████████  Done            │
│ ● Build the pricing section      ██████░░░░  60%             │
│ ○ Add the contact form           ░░░░░░░░░░  Next            │
│ ○ Polish the footer              ░░░░░░░░░░  Up next         │
╰──────────────────────────────────────────────────────────────╯
```

The header also tells you when Claude **needs you** (a permission prompt or a question), when it's **stuck**, when you **stopped** it, and when it's **all done**.

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install clean-view --marketplace mugenracerman/clean-view
```

Answer `y` to add the marketplace, then press Enter to install it for your user.

## Turn it on and off

- Click the ` Clean View: On ` toggle in the footer under the prompt, or
- type `/simple on`, `/simple off`, or just `/simple` to flip it.

Your choice is remembered after a restart. When it's off, every hidden row comes back.

## Good to know

- While it's on, Claude makes a short plain-English plan before every request, even a quick question.
- Each new request makes one small call to Claude Haiku to give the job a short name.
- Permission prompts still appear as normal, so you stay in control of risky actions.

## Tests

```
claude plugin test .
```
