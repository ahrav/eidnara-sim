# Tool-output corpus notice

`samples.jsonl` and `error-codes.jsonl` hold excerpts of tool output from
SWE-rebench-OpenHands-Trajectories by Nebius
(https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories,
revision `35455389ab51bf5e2306bfd436ef72d0f98bf882`), licensed under the
Creative Commons Attribution 4.0 International License
(https://creativecommons.org/licenses/by/4.0/).

Changes from the source: each entry is an excerpt of one tool message. The
OpenHands status footer lines are removed, content longer than 4,000
characters is cut to its first or last 4,000 characters, and the parsed exit
code, command, and repository are stored beside the text. Every entry's
`source_id` names the trajectory and message index it came from.

The output text quotes code and messages from the public GitHub repository
named in each entry's `repo` field.
