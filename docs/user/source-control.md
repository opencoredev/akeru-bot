# Source control integrations

Akeru can clone and publish repositories, create and inspect change requests, and show review state
beside the thread that owns the work.

## Supported hosts

| Host | Authentication | Change request name |
| --- | --- | --- |
| GitHub | GitHub CLI | Pull request |
| GitLab | GitLab CLI | Merge request |
| Bitbucket | Access token or account API token | Pull request |
| Azure DevOps | Azure CLI with the DevOps extension | Pull request |

Git is required on the environment server for every local repository operation.

## Add a project from a remote

1. Open the command palette with `Cmd/Ctrl+K`.
2. Select **Add Project**.
3. Choose a listed host or **Git URL**.
4. Enter the repository name or full URL.
5. Choose the destination directory.

Akeru accepts host-specific names such as `owner/repo`, `group/project`,
`workspace/repository`, or `project/repository`.

## Publish a local repository

Use **Publish Repository** on a local Git repository without a remote. Akeru creates the hosted
repository, adds it as `origin`, and pushes the current branch.

If the repository has no commits, Akeru creates the remote and adds `origin` but does not push. Make
the first commit, then push it.

## Work with change requests

Use the Git controls in the thread toolbar to push a branch and create a pull request or merge
request. Akeru can draft a title and description from the branch commits.

The **Pull requests** page opens reviews in right-panel tabs. From a thread, you can open a linked
review in the panel or in the system browser. Command-click on macOS, or Control-click on Windows and
Linux, opens a sidebar change-request number in the browser.

Akeru can check out another branch for local review. GitHub, GitLab, and Bitbucket also support
editing change-request text and your own comments in place. Azure DevOps supports title and
description edits, but its comments stay read-only in Akeru.

## Configure authentication

Open **Settings > Source Control**. The page shows **Version Control** and **Source Control
Providers**. Use the rescan icon after you install a CLI or change credentials. Its tooltip reads
**Rescan Git and hosting integrations**.

Authentication belongs to the environment server. Run these commands on that machine.

### GitHub

Install GitHub CLI 2.81.0 or newer, then sign in:

```bash
brew install gh
gh auth login
```

### GitLab

Install and authenticate GitLab CLI:

```bash
brew install glab
glab auth login
```

### Bitbucket

Set a Bitbucket access token:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or set an Atlassian account email and API token:

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

The API token needs repository and pull-request read/write access plus `read:user:bitbucket`. The
access token wins when both methods are set. Restart Akeru after you change these environment
variables.

### Azure DevOps

Install Azure CLI and its DevOps extension:

```bash
brew install azure-cli
az extension add --name azure-devops
az login
```

If Akeru reports that Azure DevOps still needs authentication, run:

```bash
az devops login
```

Rescan after authentication succeeds.

## Fix connection problems

- Update GitHub CLI when Akeru cannot verify its sign-in state.
- Confirm that authentication and Git remotes use compatible SSH or HTTPS credentials.
- Restart the server after changing Bitbucket environment variables.
- Run the provider's login command on the server, not on a remote client.
