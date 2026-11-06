# TopBinz

A daily soccer trivia game. Each prompt asks you to name something, like a Ballon d'Or winner, a club that has won La Liga or a player from a World Cup-winning squad. The rarer your correct answer, the better the finish, from a tap-in all the way up to top bins.

**Play:** https://topbinz.io

- 7 prompts a day with 25 seconds each, plus an unlimited mode
- 300 prompts covering players, clubs, countries, managers, finals and trophies
- You never see the same prompt twice: each game is dealt from prompts you haven't played yet, and an unfinished daily game picks up where you left off
- Small typos are fixed automatically, and close or ambiguous answers get suggestions
- Every result plays its own pixel-art animation: tap-in, off the post, a 30-yard free kick, a Panenka or top bins. Run out of time and Courtois saves it with all eight arms
- Play as one of 10 stars (Messi, Ronaldo, Mbappé, Yamal, Haaland, Bellingham, Neymar, Palmer, Vinícius Jr or Son), each drawn with their own hair, face and kit, and their name and number on the back. Each one earns +10 on their favorite finish and celebrates goals their own way, from Ronaldo's SIUUU to Haaland's zen pose and Vini's corner-flag dance
- Stadium sound the whole time you're on the site, plus whistles, shots, the net and every celebration, all generated in the browser, with a mute button
- Scores, streaks and today's result are saved in your browser
- **Rondo**: a live party mode for 2–10 friends. Name an unused answer to pass the ball; whoever holds it when it blows is out
- **Ballon d'Or League**: friends' daily scores are ranked with Ballon d'Or points (15, 12, 10…), the week's winner gets the Ballon d'Or and the month's top winner gets the Super Ballon d'Or

## Running it

The game is a single HTML file with no build step. Rondo rooms and leagues run on a small Cloudflare Worker in `api/`. Open `index.html` in a browser or serve the folder with any static server.

## Notes

Rarity is an estimate of how well known each answer is, not live data from other players. Prompts cover results up to November 2026.

The rarity-based scoring is inspired by [Krillion](https://krillion.io/).
