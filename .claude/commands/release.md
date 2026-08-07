Perform a release for this project. Steps:

1. Find the most recent version tag with `git describe --tags --abbrev=0` and collect all commits between it and HEAD using `git log {prev_tag}..HEAD --format="%B---"`
2. Bump the version with `npm version patch --no-git-tag-version`
3. Commit the version bump with message: `v{version}: {short summary of changes}`
4. Create a git tag `v{version}`
5. Push commits and tag: `git push origin` and `git push origin --tags` (never a bare `git push` — `main` tracks `upstream`, not `origin`, and a bare push targets `doctly/switchboard`). Note `main` is branch-protected: the version-bump commit must land via a PR (admin-merge is fine), and the tag must be created on the merged `main` commit, not the pre-merge local commit — see [README.md § Fork release-flow gotchas](../../README.md#fork-release-flow-gotchas).
6. Wait for the GitHub Actions build to complete using `gh run watch` on the latest run
7. Once the build finishes and creates a draft release, publish it with release notes using `gh release edit v{version} --draft=false --notes "..."`
8. Release notes format:
   ```
   ## What's Changed

   ### {Category}
   - {change description}

   ### {Category}
   - {change description}
   ```
   Group changes by category (e.g. "Features", "Bug Fixes", "Performance Improvements", etc.) based on the commit messages. The release notes must cover ALL commits between the previous tag and the new tag — don't skip any.