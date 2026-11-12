# Art for Moonbridge: where the files go

Pictures live in `content/media/`; the server serves them at `/content/media/…`, and the game
picks them up the next time the scene opens. Until a file is there, the scene shows a stand-in
(a gradient backdrop, a framed letter for a character), so art can arrive one file at a time.

PNG or WebP both work. Keep the names below, or change the path in the JSON.

## Places (`content/moonbridge/places.json`)

| Place      | Night                         | Day                               |
|------------|-------------------------------|-----------------------------------|
| Reception  | `places/reception.png`        | `places/reception-day.png`        |
| Lift       | `places/lift.png`             | `places/lift-day.png`             |
| Lobby      | `places/lobby.png`            | `places/lobby-day.png`            |
| Night Café | `places/cafe.png`             | `places/cafe-day.png`             |

Portrait orientation, about 1080 × 1920, the important part in the middle: phones crop the sides.
Without a day picture the night one is shown.

## Characters (`content/moonbridge/characters.json`)

Night: `characters/<id>/neutral.png`, `happy.png`, `upset.png`.
Day (who the character is by day, `day` in the JSON): `characters/<id>/day-neutral.png`, `day-happy.png`, `day-upset.png`.

| id    | Night     | Day                           |
|-------|-----------|-------------------------------|
| rocco | werewolf  | man                           |
| lev   | gargoyle  | man                           |
| pip   | fairy     | girl                          |
| kai   | ghost     | ghost (no `day`: the same)    |

A transparent PNG, 3:4, the character standing on the bottom edge (feet or waist cut by the frame),
about 900 × 1200. The game moves the picture (steps in, hops, shudders), so no motion is needed in the art.

## Day and night in the content

- An episode with `"time_of_day": "day"` plays in daylight with the residents' day faces; the default is night.
- `"side": true` makes it a side quest: listed on the map, but the unit and the homework do not wait for it.
- A step `{ "kind": "scene", "place_id": "lift", "transition": "lift" }` moves the scene; transitions: `fade`, `lift`, `cut`.
- A line may say `{name}`: the student's first name.
- `reactions` on a character: what they say after a right answer, a typo or a mistake.

The hotel on the map follows the clock (day from 7:00 to 19:00); the ☀ / ☾ button switches it by hand.

## Buildings on the town map

The map has a building per unit; a unit's building is the place it opens. A transparent picture at
`buildings/<place>.png` (`building` in `places.json`, column «здание» in the sheet), square, about
400 × 400, replaces the drawn house. Its windows stay drawn by the game only on the drawn house.
