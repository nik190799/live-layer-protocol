// "Hotfix waits on a release" model: a live game client. Each player's session (coins, level,
// inventory) lives in host state. Buying an item costs its price.
import { col, label, end, getNum, setNum, eventId, eventValue, fmt } from "../../sdk/assemblyscript/llp";
export function view(): void { col(); label("level " + fmt(getNum("level")) + ", coins " + fmt(getNum("coins")) + ", items " + fmt(getNum("items"))); end(); }
export function play(costOf: (price: f64) => f64): void {
  const id = eventId();
  if (id == "win") { setNum("coins", getNum("coins") + 50); setNum("level", getNum("level") + 1); }
  else if (id == "buy") {
    const price = <f64>I32.parseInt(eventValue());
    const cost = costOf(price);
    if (getNum("coins") >= cost) { setNum("coins", getNum("coins") - cost); setNum("items", getNum("items") + 1); }
  }
}
