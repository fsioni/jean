/**
 * Hardcoded release-notes instruction used by the "Update PR description" flow.
 *
 * Instead of a one-shot AI call, the Update-PR modal spawns a yolo chat session
 * seeded with this prompt plus the target PR number. The agent gathers the PR's
 * commits + closing-keyword issue references, writes user-facing grouped notes,
 * and updates the PR description in place via `gh pr edit`.
 *
 * This mirrors the `/release` slash command but is owned by Jean (no dependency
 * on any external skill file).
 */
const RELEASE_NOTES_INSTRUCTION = `You are updating the description of an existing GitHub pull request with user-facing release notes, following the /release command workflow as closely as possible.

## First: update local branch data
Before generating notes, pull the latest commits to ensure complete data:
1. Identify the current branch name.
2. Inspect the target PR using the GitHub CLI to identify its base and head branches:
   - \`gh pr view <PR_NUMBER> --json number,title,body,baseRefName,headRefName,commits\`
3. Identify the comparison branch from the PR base branch. If unavailable, use the repository's default release comparison branch (usually \`v4.x\` or \`main\`).
4. Run \`git fetch origin\` to update remote tracking branches.
5. Run \`git pull origin <current-branch>\` to update the current branch.
6. Run \`git fetch origin <comparison-branch>:<comparison-branch>\` to update the comparison branch locally.

## Gather release evidence
Then check the current branch's commits and merged PRs since it diverged from the comparison branch. Use the GitHub CLI to:
1. Get all commits in this branch that aren't in the comparison branch.
2. For each commit, check if it is from a merged PR and get the PR number and description.
3. For each merged PR, also check its git commit history to gather additional context.
4. Look for issue references using GitHub's official closing keywords in both PR descriptions AND commit messages using case-insensitive matching:
   - close/closes/closed
   - fix/fixes/fixed
   - resolve/resolves/resolved
   All variations like "Fixes #123", "CLOSES #456", "fixed #789", "Resolves #100", etc. count.
5. Collect all unique issue numbers that are fixed by PRs or mentioned in commits.
6. Use \`gh pr diff <PR_NUMBER>\` only for additional context when the PR and commit metadata are not enough.

## Writing the notes
Generate a brief, non-technical release description:
- Start the body with a \`## What's Changed\` heading.
- Group changes by category: \`### Security & Fixes\`, \`### New Services & Templates\`, \`### Improvements\`.
- Include only categories that have entries.
- Use simple, user-friendly language (no technical jargon).
- Keep each item to one short line.
- For each line item, show the source PR number as \`(#123)\` when it is not the target PR.
- Do not include the target PR number as a self-reference. These notes are the target PR description, so \`(#<PR_NUMBER>)\` is noise.
- If the only known source PR for a line is the target PR, omit the PR ref but still include detected issue refs, for example \`(fixes #456, #789)\`.
- IMPORTANT: If a source PR or its commits fix specific issues, add those after the source PR using the keyword found: \`(#234, fixes #456, #789)\` or \`(#345, closes #100)\`. If the source PR is the target PR, write only \`(fixes #456, #789)\` or \`(closes #100)\`.
- Always use lowercase for the keyword in the final output: fixes, closes, resolves.
- Include all new service templates and one-click services added.
- Skip internal refactoring, dependency updates, and minor tweaks unless significant.
- Do not add commit numbers or commit links into the notes.
- Do not invent PR or issue numbers; only use references you actually detected.
- Keep it scannable — users should understand the key changes in 15 seconds.

## Format
## What's Changed

### Security & Fixes
- Brief user-facing description (#234, fixes #456, #789)
- Target-PR-only fix description (fixes #456, #789)

### New Services & Templates
- Added ServiceName template (#234)
- Updated ExistingService to vX.X.X (#345)

### Improvements
- Enhancement description (#456)
- Another improvement (#567)

## Implementation details for finding issue references
To find issue references across PRs, use this bash script approach:

\`\`\`bash
# Create a script to check all PR numbers for issue references
cat > /tmp/check_prs.sh << 'EOF'
#!/bin/bash
for pr in <PR_NUMBERS>; do
  result=$(gh pr view $pr --json body,title 2>/dev/null | jq -r '.title + "\\n" + (.body // "")' | grep -iE "(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+#[0-9]+" | head -3)
  if [ -n "$result" ]; then
    echo "PR #$pr:"
    echo "$result"
    echo "---"
  fi
done
EOF
chmod +x /tmp/check_prs.sh
/tmp/check_prs.sh
\`\`\`

Alternative quick check for a single PR:

\`\`\`bash
gh pr view <PR_NUMBER> --json body,title | jq -r '.title + "\\n" + (.body // "")' | grep -iE "(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+#[0-9]+"
\`\`\`

## Applying the update
Use \`gh pr edit <PR_NUMBER> --body "<generated_markdown>"\` to update the target PR description with the generated release notes.
After updating, fetch the PR's full URL with \`gh pr view <PR_NUMBER> --json url -q .url\`.
Then confirm to the user that PR #<PR_NUMBER> was updated, show the full clickable PR URL on its own line, and show the final notes.`

/**
 * Build the full session prompt for updating a specific PR's description.
 */
export function buildReleaseNotesSessionPrompt(prNumber: number): string {
  return `${RELEASE_NOTES_INSTRUCTION}

## Target
PR_NUMBER = ${prNumber}

Update PR #${prNumber} now.`
}
