# The fourth cut's new lines (the rest are reused from the third: see build_v4_audio.py).
# The name is Saseo (사서, Korean for librarian), said "sah soe": the voice reads it spelled that way.
# The closing line ("Sah-soe is an attempt to realize...") is voiced the same way, as d5-close__00.
import json
D = "Same educated Southern English man as always. Read it like a radio announcer: plain, even and steady, clear diction, no acting, no drama."
Y = "Same casual, curious person on a video call. Natural and relaxed, like really asking, not performed."
lines = {
  "d2-explore": ["But try to really understand something, say Hamiltonian mechanics, and you're on your own.", "One page leads to another, and there's nowhere to keep what you've worked out."],
  "d3-intro": ["Sah-soe is a place for that.", "You call a librarian, and it works on the page with you."],
  "d4-space": ["Keep going, and the page fills up with what you've found and how it all connects.", "Come back next week, and it's exactly where you left it."],
}
out = [{"id": f"{k}__{i:02d}", "voice": "oxford", "text": t, "direction": D} for k, v in lines.items() for i, t in enumerate(v)]
out.append({"id": "q0", "voice": "you", "text": "What is a Hamiltonian, and why is it the energy?", "direction": Y})
json.dump(out, open("lines_v4.json", "w"), indent=1)
# The librarian's (Kokoro) lines: a new first answer, and the first answer cut to its first sentence.
json.dump([{"id": "a0", "text": "Let me put a card together for that."}, {"id": "a1", "text": "Sure, let me break that down on the card."}], open("answers_v4.json", "w"), indent=1)
print(len(out), "lines")
