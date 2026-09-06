export const HELP_COMMANDS = ['demo', 'run', 'compare', 'bisect', 'minimize', 'verify', 'bundle', 'artifacts', 'mcp'] as const;
export type HelpCommand = typeof HELP_COMMANDS[number];

const common = `Common options:
  --cwd DIRECTORY    Resolve command, input and artifact paths here (default: .)
  --json             Print one JSON result without terminal progress
  --help, -h         Show this command's help
`;

const outputLimits = `  --max-output-bytes N        Combined stdout/stderr cap per trial (16777216)
  --max-total-output-bytes N  Combined output cap for the investigation (268435456)
                              Limits preserve partial evidence; exit 2.
`;

const predicates = `Failure condition (choose one; default: non-zero exit):
  --exit-code N              Match exactly this exit code, including 0
  --stdout-contains TEXT | --stderr-contains TEXT
  --stdout-regex REGEX   | --stderr-regex REGEX [--regex-flags imsu]
  --nunit-test FULLNAME      Read one exact test from a fresh NUnit 3 report
  --nunit-message TEXT       Also require this text in the target failure message
  With --nunit-test, pass --arg "{testReport}" as the runner's result path,
  or have a wrapper write to FAILTRACE_TEST_REPORT. Missing, skipped, ambiguous
  or unrelated failed tests are inconclusive. XML reader limit: 4 MiB.
  Regex checks allow at most 16 MiB and one second per evaluation.
  Use --stderr-contains=--message for text starting with --.

Completed-check signal (optional):
  --require-stdout-contains TEXT | --require-stderr-contains TEXT
  Choose one signal emitted after the intended check. A missing signal makes
  classification/verification inconclusive; it is separate from the failure.
`;

const directCommand = `Direct execution:
  --exec PROGRAM --arg VALUE ...  Pass literal arguments without a target shell
  Repeat --arg for each argument, including flags. Do not combine --exec with
  a shell command. Quote values containing spaces for your invoking shell.
  Use a native executable; shell builtins and Windows .cmd/.bat shims need
  the shell-command form.
`;

const shellNote = `Shell commands use the platform shell (normally cmd.exe or /bin/sh).
Put complex setup in a project script. Commands receive no interactive stdin.
`;

const interruption = 'Ctrl+C preserves partial evidence; interruption exits 130 (SIGINT) or 143 (SIGTERM).';

const pages: Record<HelpCommand, string> = {
  demo: `FailTrace demo - try a complete investigation

Usage:
  failtrace demo [--cwd DIRECTORY] [--json]

Repeat a controlled failure, reduce its input, reject an unrelated crash,
check a proposed fix, and save a replay bundle. Works from any directory.
The demo writes only its new investigation directory under .failtrace/demos/.

${common}
Next:
  Run the printed replay command; exit 1 means the expected failure reproduced.
  Try your own command with failtrace run --help.

Exit: 0 demo completed, 2 incomplete/error. ${interruption}
`,
  run: `FailTrace run - repeat a command and save its evidence

Usage:
  failtrace run "<command>" [--repeat N] [--timeout DURATION]
  failtrace run --exec PROGRAM [--arg VALUE ...] [--repeat N]

Options:
  --repeat N          Trial count (10; maximum 100000); run attempts every trial
  --timeout DURATION  Per-trial timeout (30s); ms, s, m, or bare milliseconds
  --concurrency N     Maximum active trials (1; maximum 64)
  --capture-env KEYS  Comma-separated selected environment values to record
  --capture-context  Record source identity before/after execution for Verify
  --context-input FILE | --context-setup FILE | --context-source FILE
                     Repeatable regular files; each implies context capture
${outputLimits}
${predicates}
${directCommand}
${common}
Example (adapt the command and failure text to your project):
  failtrace run "npm test" --repeat 20 --stderr-contains "checkout failed" --capture-context

Next:
  Use the printed run ID/path with failtrace compare RUN_ID.
  Capture a baseline before editing; see failtrace verify --help.

${shellNote}Concurrency can change failure behavior through shared resources.
Failed counts include execution failures; Matched counts the chosen target.
Exit: 0 no failed outcomes, 1 failed trials, 2 invalid/incomplete evidence.
${interruption}
`,
  compare: `FailTrace compare - inspect differences in saved trial evidence

Usage:
  failtrace compare <run-a> [run-b] [--trial-a N] [--trial-b N]

Run references can be an ID, a run directory, or a run.json path.
With one run, prefer a clean exit-0 nonmatch and a target match.
With two runs, select the first trial in each unless indices are supplied.
This command reads saved evidence and does not execute the target.

Options:
  --trial-a N         Positive trial index from run A
  --trial-b N         Positive trial index from run B (or A when B is omitted)
  --max-lines N       Maximum displayed diff lines (200; maximum 10000)
  --max-bytes N       Prefix bytes per stream (65536; maximum 1048576)
${common}
Example (replace RUN_ID with your printed run ID or path):
  failtrace compare RUN_ID --trial-a 1 --trial-b 2 --json

Next:
  Read selectedTrials and warnings before interpreting an output difference.
  For a patch verdict using baseline context, see failtrace verify --help.

Complete stream hashes remain available even when the displayed diff is cut.
Comparison does not establish that the experiment is equivalent or a fix worked.
Exit: 0 evidence compared, 2 invalid/incomplete evidence. ${interruption}
`,
  bisect: `FailTrace bisect - locate a sampled regression boundary

Usage:
  failtrace bisect --good REF --bad REF --command "<command>"
  failtrace bisect --good REF --bad REF --exec PROGRAM [--arg VALUE ...]

Checks both endpoints, then searches the bad revision's first-parent history.
Runs each candidate in a separate temporary worktree; your checkout is preserved.

Options:
  --good REF, --bad REF       Required good and bad Git revisions
  --command COMMAND          Required shell command unless --exec is supplied
  --repeat N                 Maximum trials per candidate (5; maximum 100000)
  --min-failures N            Matches required to reproduce (1; at most repeat)
  --timeout DURATION         Per-trial timeout (30s); ms, s, m, or milliseconds
  --healthy-exit-code N       Repeatable healthy target-nonmatch codes (default: 0)
  --inconclusive-exit-code N  Repeatable setup/untestable codes (default: none)
                             Inconclusive codes take precedence over matches.
${outputLimits}
${predicates}
${directCommand}
${common}
Example (choose a known good revision and your target message):
  failtrace bisect --good GOOD_REF --bad HEAD --command "npm test" --stderr-contains "checkout failed"

Next:
  If setup fails, inspect the candidate reason/logs before choosing new revisions.
  Include dependency setup in your project command: temporary candidates are
  reset and cleaned, including ignored dependencies and build output.

${shellNote}Trials are sequential and stop once the threshold is decided. This assumes a
monotonic sampled boundary; it does not establish statistical confidence.
Exit: 0 boundary found and cleanup succeeded, 2 inconclusive/error/cleanup issue.
${interruption}
`,
  minimize: `FailTrace minimize - shrink input while retaining the target failure

Usage:
  failtrace minimize --input PATH --command "<command>" [--format text]
  failtrace minimize --input PATH --exec PROGRAM --arg "{input}" [--format text]

Input formats:
  text   UTF-8 file; remove lines, then Unicode characters (default)
  json   JSON file; remove array elements and object members
  files  Dedicated directory; remove whole files, preserve relative paths
  env    JSON object of variable names/string values; remove environment keys

Options:
  --input PATH               Required original input; it is preserved
  --command COMMAND          Required shell command unless --exec is supplied
  --format text|json|files|env
  --repeat N                 Maximum trials per candidate (1; maximum 100000)
  --min-failures N            Matches required to reproduce (1; at most repeat)
  --timeout DURATION         Per-trial timeout (30s); ms, s, m, or milliseconds
  --max-evaluations N         Baseline, candidates and final check (200; 2..10000)
  --max-input-bytes N         Original/candidate input cap (16777216)
  --max-candidate-bytes N     Cumulative retained input copy cap (268435456)
${outputLimits}
${predicates}
${directCommand}
For direct execution, an entire --arg "{input}" is replaced by the candidate
path as one literal argument. The original input path is never substituted
into shell text. Use a target that already accepts a file/directory argument.
Shell scripts can instead read FAILTRACE_INPUT (text/json/env) or
FAILTRACE_INPUT_DIR (files). Always test the candidate, not the original path.

${common}
Example (check.mjs must accept the input file as its argument):
  failtrace minimize --input cases.json --format json --exec node --arg check.mjs --arg "{input}" --stderr-contains "TARGET_FAILURE"

Next:
  Baseline not_reproduced: check the input connection and target signature.
  Check status and finalVerified before using minimizedPath.
  Bundle final.runDirectory with minimizedPath; see failtrace bundle --help.

Trials are sequential and may stop once the match threshold is decided.
The final check is independent; the result has no global-smallest guarantee.
Exit: 0 completed and final-verified, 2 not reproduced/inconclusive/limit/error.
${interruption}
`,
  verify: `FailTrace verify - recheck a patch against captured baseline evidence

Usage:
  failtrace verify <baseline> --command "<command>" --cwd DIRECTORY
  failtrace verify <baseline> --exec PROGRAM [--arg VALUE ...] --cwd DIRECTORY

Before editing, capture a run with --capture-context or explicit context files.
The baseline must reproduce the target with complete, stable context evidence.
Verify requires your explicit current command and working directory.

Options:
  --command COMMAND       Current shell command unless --exec is supplied
  --cwd DIRECTORY         Required; must match the baseline's canonical directory
  --repeat N              Full candidate trial count (inherits baseline; maximum 100000)
  --timeout DURATION      Per-trial timeout (inherits baseline); ms, s, m
  --concurrency N         Maximum active trials (inherits baseline; maximum 64)
  --healthy-exit-code N   Repeatable healthy target-nonmatch codes (default: 0)
  --allow-change FIELD:REASON  Repeat for each intended intervention
                           Fields: command, source, inputs, setup, environment,
                           timeout, concurrency, outputLimits
  --max-output-bytes N | --max-total-output-bytes N
                           Inherit baseline; changes need outputLimits allowance
  --json                  Print one JSON result without terminal progress
  --help, -h              Show this command's help

${directCommand}
Predicate, completed-check signal, and context declarations inherit baseline.
There are no new --stderr-contains or --context-source flags on verify.

Example (replace BASELINE_ID; declare your actual intended source change):
  failtrace verify BASELINE_ID --command "npm test" --cwd . --allow-change "source:repair checkout handling" --json

Next:
  Inconclusive: inspect reasons, baselineEligibility, changes and plan.
  Missing context requires a new baseline captured before the change.
  Declare only deliberate differences; allowances cannot replace missing evidence.

${shellNote}No matches in a healthy, comparable finite sample does not prove elimination.
Exit: 0 target_not_observed, 1 target_observed, 2 inconclusive/invalid.
${interruption}
`,
  bundle: `FailTrace bundle - package selected evidence for local replay

Usage:
  failtrace bundle <run> [--file PATH ...] [--input PATH]

Run references can be an ID, a run directory, or a run.json path.
Creates a new bundle; does not execute the target or publish anything.

Options:
  --file PATH             Repeatable regular source files, relative to run cwd
  --input PATH            Selected input file or directory to relocate for replay
  --command COMMAND       Optional replay shell command override
  --exec PROGRAM --arg VALUE ...  Optional direct replay command
  --output NEW_DIRECTORY  New destination (default: .failtrace/reproduction/<id>)
  --env-file JSON_FILE    Reviewed environment overrides; string values or null
  --include-env KEY       Repeatable captured values to include (default: none)
  --include-evidence      Include unchanged original logs/metadata (default: off)
  --max-bundle-bytes N    Combined bundle cap (536870912)
${common}
Example (replace FINAL_RUN and MINIMIZED_PATH with your result's paths):
  failtrace bundle FINAL_RUN --file check.mjs --input MINIMIZED_PATH

Next:
  Review manifest.json, repro.json and selected files before sharing.
  Follow the generated README for target dependencies/environment prerequisites.
  Run the printed node command to replay the bundle and retain new evidence.

For a direct replay override, --input supplies an entire --arg "{input}".
Review saved absolute arguments and supply a portable override when needed.

The Node engine is included; target dependencies/services need separate setup.
Omitted captured environment keys become prerequisites for replay.
Exit: 0 bundle created, 2 invalid/error. Replay: 1 target reproduced, 0 absent
in a healthy sample, 2 inconclusive/error. ${interruption}
`,
  artifacts: `FailTrace artifacts - inspect retained storage without changing it

Available since FailTrace 1.2.0. No files are deleted.

Usage:
  failtrace artifacts [--directory STORAGE_ROOT] [--max-entries N] [--json]

Options:
  --directory STORAGE_ROOT  Storage root (default: .failtrace relative to cwd)
  --max-entries N           Entry inspection budget (20000; maximum 100000)
${common}
Example:
  failtrace artifacts --json

Next:
  Read issues and complete before relying on totals from a partial scan.
  Preserve investigations with their referenced runs and reproduction inputs.

Reports logical bytes, known references, and unknown files; does not delete,
create artifacts, or execute commands. Reported state and absent references
do not establish that an investigation is inactive or safe to delete.
Exit: 0 complete snapshot, 2 partial/invalid/error. ${interruption}
`,
  mcp: `FailTrace mcp - expose local debugging experiments to coding agents

Usage:
  failtrace mcp [--cwd DIRECTORY]

Options:
  --cwd DIRECTORY  Default project directory for tool requests (default: .)
  --help, -h       Show this command's help without starting the server

Configure your MCP client to launch this command through stdio. Running it
alone waits for requests; it does not display a terminal interface.

Tools:
  failtrace_run, failtrace_compare, failtrace_bisect, failtrace_minimize,
  failtrace_verify, failtrace_bundle, failtrace_inspect_run

Next:
  Set the client command to failtrace (failtrace.cmd for a Windows shim),
  with args ["mcp", "--cwd", "/absolute/path/to/project"].
  Ask the agent to select a failure signature and run a bounded sample.

The client chooses when to call tools. stdout is reserved for MCP messages;
diagnostics use stderr. There is no --json option on the MCP server.
Target failures are experiment data; saved target output is untrusted text.
Executes with your local permissions. No account or AI API is required.
`,
};

export const HELP = `FailTrace - debugging experiments for coding agents and developers

Usage:
  failtrace <command> [options]
  failtrace <command> --help

Commands:
  demo       Try repetition, minimization, fix verification and replay
  run        Repeat a command and record its failure evidence
  compare    Inspect differences between saved trials
  bisect     Locate a sampled regression boundary in Git history
  minimize   Shrink reproducing text, JSON, files or environment keys
  verify     Recheck a patch against a captured baseline
  bundle     Package selected files and evidence for local replay
  artifacts  Read-only storage inventory
  mcp        Start the local stdio server for coding agents

Start here:
  failtrace demo
  failtrace run "npm test" --repeat 20 --timeout 30s
  failtrace minimize --help

Use command help for its options, examples, result meanings and next steps.
--json prints results without progress; mcp reserves stdout for the protocol.
--version, -v shows the installed version. --help, -h shows this page.
Artifacts are saved under .failtrace/ by default; review before sharing.
Exit 1 from run can mean the failure you are investigating was recorded.
`;

/** Help is read-only and selects only the requested command's options. */
export function formatHelp(command?: HelpCommand): string {
  return command === undefined ? HELP : pages[command];
}
