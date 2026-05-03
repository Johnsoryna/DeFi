# Codex Automation

This repository uses Codex through GitHub Actions for repeatable cloud work on branch `v1`.

## What This Setup Does

- PR review on pull requests into `v1`
- continuous read-only audits on a schedule and on manual dispatch
- automated maintenance runs that can open PRs back into `v1`

## Required Secret

Add this GitHub Actions secret before expecting Codex jobs to do useful work:

- `OPENAI_API_KEY`

Without that secret, the workflows will start and then skip safely.

## Important Branch Rule

GitHub scheduled workflows only run from the repository default branch.
If you want the recurring schedules to stay live for `v1`, do one of these:

1. make `v1` the default branch, or
2. merge these workflow files into the default branch and keep them checking out `v1`

Push-triggered and pull-request-triggered runs work on `v1` immediately.

Activation note: branch `v1` is intended to be the default branch for this automation setup.

## Safety Model

- review and audit jobs run read-only
- maintenance runs in `workspace-write`
- maintenance opens PRs instead of pushing directly to `v1`
- Codex multi-agent support is enabled for action runs through `--enable multi_agent`

## Practical Limitation

No automation can honestly prove the repository is "100% perfect" or that no future useful work exists.
This setup is designed to keep finding, validating, and shipping high-value improvements until runs stop producing meaningful changes.
