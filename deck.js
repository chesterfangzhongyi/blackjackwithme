// deck.js
// Card representation, deck creation, shuffling, dealing, and blackjack scoring.

const SUITS = ["hearts", "diamonds", "clubs", "spades"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

// Base value for each rank. Ace is handled specially in scoreHand().
const RANK_VALUE = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  "J": 10, "Q": 10, "K": 10, "A": 11
};

/**
 * Build a fresh, ordered 52-card deck.
 * Each card: { rank: "A", suit: "spades" }
 */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle. Mutates and returns the array.
 */
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Deal `count` cards off the top of the deck (mutates deck, returns dealt cards).
 * Deck is treated as a stack: last element = top of deck.
 */
function deal(deck, count = 1) {
  const dealt = [];
  for (let i = 0; i < count; i++) {
    if (deck.length === 0) {
      throw new Error("Deck is empty — need to reshuffle/rebuild before dealing more.");
    }
    dealt.push(deck.pop());
  }
  return dealt;
}

/**
 * Score a hand, correctly downgrading Aces from 11 -> 1 to avoid busting.
 * Returns { total, soft } where soft = true if an Ace is still counted as 11.
 */
function scoreHand(hand) {
  let total = 0;
  let aceCount = 0;

  for (const card of hand) {
    total += RANK_VALUE[card.rank];
    if (card.rank === "A") aceCount++;
  }

  // Downgrade Aces (11 -> 1, i.e. subtract 10) while busting and an Ace is available.
  while (total > 21 && aceCount > 0) {
    total -= 10;
    aceCount--;
  }

  // "Soft" = at least one Ace is still being counted as 11.
  const soft = aceCount > 0;

  return { total, soft };
}

function isBlackjack(hand) {
  return hand.length === 2 && scoreHand(hand).total === 21;
}

function isBust(hand) {
  return scoreHand(hand).total > 21;
}

/**
 * Base value of a single card for split-eligibility checks (J/Q/K/10 all
 * count as 10, Ace as 11) — NOT the same as scoreHand's soft-Ace handling,
 * this is just "do these two cards match for splitting purposes."
 */
function cardBaseValue(card) {
  return RANK_VALUE[card.rank];
}

module.exports = {
  SUITS,
  RANKS,
  createDeck,
  shuffle,
  deal,
  scoreHand,
  isBlackjack,
  isBust,
  cardBaseValue,
};
