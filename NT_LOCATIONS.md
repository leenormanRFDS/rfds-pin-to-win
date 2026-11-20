# Northern Territory destinations

The game has 18 NT destinations. Top End destinations use **Darwin** as the challenge departure base (10) and Central Australian destinations use **Alice Springs** (8). The seven below have documented reference points; the rest use their town or airstrip coordinates in `data/destinations.js`.

| Destination | Latitude | Longitude | Base | Game interpretation |
| --- | ---: | ---: | --- | --- |
| Tennant Creek | -19.6344 | 134.1830 | Alice Springs | Tennant Creek Airport. |
| Galiwinku (Elcho Island) | -12.0194 | 135.5710 | Darwin | Elcho Island Airport. |
| Tiwi | -11.76494 | 130.61585 | Darwin | Bathurst Island Airfield, Wurrumiyanga. The selected point for the wider Tiwi Islands. |
| Borroloola | -16.0754 | 136.3028 | Darwin | Borroloola Aerodrome. |
| Maningrida | -12.0561 | 134.2342 | Darwin | Maningrida Airport. |
| Gove | -12.274467 | 136.823902 | Darwin | Gove Airport, serving Nhulunbuy. |
| Ti Tree | -22.12732 | 133.42237 | Alice Springs | Ti Tree Airstrip. |

Mt Doreen Station appeared in earlier notes but is not in the current destination list. `data/destinations.js` is the only source the game loads.

## Limitations

Departure bases and tasking descriptions are **game routes**. They illustrate the kinds of work the RFDS does and do not assert that the RFDS operates each depicted leg or tasking type from that base.

`/data/index.html` is intentionally empty so the folder doesn't serve a stale copy of the game.
