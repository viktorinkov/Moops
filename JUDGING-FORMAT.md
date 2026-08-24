**OFFICIAL JUDING POST**

Hi everyone! Excited to see you tomorrow. Sharing some info on the judging format below:

​

There will be an overall 1st, 2nd, and 3rd place, based on the following criteria:

​

-Technical Difficulty (30%) – Did you tackle a challenging engineering problem?

-Execution (25%) – Does your project work? Is it polished and well-built?

-Creativity (20%) – Is your idea original or a novel approach to a problem?

-Impact (15%) – Does your project solve a meaningful problem or have real-world potential?

-Presentation (10%) – Can you clearly communicate what you built and why it matters?

​

There is also one separate sponsor prize track from Claude-Mem: a $1,000 Memory Prize for the best project that incorporates agent memory. This will be judged separately from the overall competition, so you can win both the Claude-Mem prize and an overall 1st–3rd place spot.

​

For the Claude-Mem track, here are seven directions to explore — pick one, combine a few, or bring your own:

-Warm boot. An agent that opens with instant context instead of burning its first ten turns rediscovering the codebase.

-Build on the timeline. Use the timeline context and the mem-search skill as your retrieval layer for something new.

-Give the skills a face. Wrap the CLI-shaped skills in UI or UX that makes memory something you can see, steer, or share.

-Build an integration. Wire Claude-Mem into somewhere it doesn't live yet — your editor, CI, chat app, or another agent framework/harness.

-Ingest anything, look for anything. Use observations across images, screenshots, transcripts, logs, issues, commit history, support tickets, and more.

Fire on what it sees. Hook actions off observations as they land in real time.

-Memory as a speed play. Use recall to cut tokens, turns, or wall-clock time.

​

And finally: everything scores extra for being something someone would actually use.

​

Repo + skills for the Claude-Mem prize track: github.com/thedotmack/claude-mem

**Make sure you ground your solution on this. This is especially relevant to the readme.**

**Here is a quick outline of the readme format I look for:**

I currently work as a research software engineer at the Snyder Lab at Stanford, where I develop the native android and iOS apps for StudySync, a wearable health data collection platform.

In the past, I worked as a web developer where currently agents thrive. On native mobile, they do not.

Codex is trained using reinforcement learning on real tasks to iteratively run tests until they pass.

The reinforcement learning loop varies between mobile and web.

On the web, the reinforcement loop:

Edit -> Hot module replacement -> agent can inspect and verify the result

On mobile, the reinforcement loop is:

Edit -> build -> restore state from scratch -> agent can inspect and verify the result

Moops solves the problem of restoring the state in order to speed up the verification process of the reinforcement loop.

MOOPS’s flow is:
- TBD by you (make sure to use my writing style, if needed create a file denoting my writing preferences)

How it works
- TBD by you (use a visual draw IO color diagram that is grounded in how other notable open source projects look, use one diagram that is most clear and complete)

Why hasn't anybody done it yet?
- TBD by you

Why is it technically challenging?
- TBD by you

Existing Solutions:

InjectionIII
- Edit -> hot code injection into the running app -> agent can inspect and verify the result
- Hot reload is faster, but only for injectable edits.
    - Injectable edits
        - Change function/method body
    - It fails at:
        - Add/remove/reorder stored properties
        - Add/rename/delete source files
        - Change domain model (Add Instructions property to Order struct)

How it works:


- XCode Preview
    - Edit -> 	mock appropriate Checkout state -> agent can inspect and verify the result

How it works: TBD by you, high level techincal explanation using multiple concise bullets like how I do and diagram

XCode UIAutomationTest

- TBD in same format

How it works:
- TBD in same format

How we are benchmarking moops

- High level explanation of benchmark. Use short bullets of the steps and what exactly each step shows as needed

Results

- Here we will have the demo video once completed.

- It should explain where it each codex run struggled based on the conversation logs.

Impact:

Reinforcement learning application.


Note the jerboa repo, add a claud mem section to the MOOPS implementation. This readme is a rough outline.

DO NOT REFERENCE IN THE README this is a hackathon project. Make sure to include an impact section that is clearly labeled. Make sure that you also referencei n the introduction information about how currently benchamrks fail on native iOS development compared to web.
