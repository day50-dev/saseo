import json
D = "Same educated Southern English man as always. Read it like a radio announcer: plain, even and steady, clear diction, no acting, no drama."
Y = "Same casual, curious person on a video call. Natural and relaxed, like really asking, not performed."
lines = {
  "d0-promise": ["The web was supposed to be the world's information at your fingertips.", "Whatever happened to that?"],
  "d1-noise": ["The internet has become very good at getting your attention.", "Consuming information has never been easier.", "Exploring an idea is another matter."],
  "d2-explore": ["Some subjects take sustained attention and more than one reference, and you have to keep hold of what you've worked out along the way.", "There's no place on the internet built for that."],
  "d4-space": ["Find how things are connected, take notes, watch demonstrations, modify your goals, and come back later with everything exactly where you left it."],
  "d5-close": ["Not a better article, a better video, or a better chatbot.", "Librarian is an attempt to realize the potential of the World Wide Web as we once dreamed it would be: a place to learn, explore, and engage with new ideas, deeply and meaningfully."],
}
out = [{"id": f"{k}__{i:02d}", "voice": "oxford", "text": t, "direction": D} for k, v in lines.items() for i, t in enumerate(v)]
for i, q in enumerate(["Can you expand on this?", "Give me some examples of Hamiltonian systems.", "Can you draw me a diagram of phase space?"]):
    out.append({"id": f"q{i+1}", "voice": "you", "text": q, "direction": Y})
json.dump(out, open("lines_v3.json", "w"), indent=1)
print(len(out), "lines")
