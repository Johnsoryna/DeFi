# Codex Cloud Setup

This repository is configured for the documented Codex Cloud + GitHub integration path.

## Supported By Official Docs

- Codex Cloud can work on coding tasks in the background in a cloud environment.
- In GitHub pull requests, `@codex review` triggers a Codex review.
- You can enable automatic reviews for the repository in Codex settings.
- If you mention `@codex` with something other than `review`, Codex starts a cloud task using the pull request as context.
- GitHub reviews follow `AGENTS.md` instructions from the closest matching file.

## How To Use It For This Repo

1. In Codex/ChatGPT, open the GitHub integration settings for `Johnsoryna/DeFi`.
2. Enable `Code review`.
3. Enable `Automatic reviews` if you want every PR reviewed automatically.
4. Open pull requests against branch `v1`.
5. Use PR comments such as:
   `@codex review`
   `@codex investigate the build failure on v1`
   `@codex fix the CI failures`

## Important Limitation

The official Codex Cloud and GitHub integration docs do not describe a built-in scheduler that will keep inventing and running new repository tasks forever without prompts or pull-request events.

So the documented cloud-native loop is:

- open PRs against `v1`
- let automatic reviews run
- trigger additional cloud tasks with `@codex ...` comments when needed

If you want true recurring scheduled runs independent of PR activity, that is the separate GitHub Action path, not the pure Codex Cloud + GitHub integration path.
