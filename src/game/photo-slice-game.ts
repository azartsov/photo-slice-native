export type Vector2 = {
  x: number;
  y: number;
};

export type Direction = "up" | "down" | "left" | "right";

export type Hazard = {
  id: number;
  position: Vector2;
  velocity: Vector2;
  radius: number;
  angle: number;
  spin: number;
};

export type ActiveCut = {
  points: Vector2[];
  head: Vector2;
  direction: Direction;
};

export type PhotoSliceGameEvent = {
  type: "life-lost" | "hazards-cleared";
  count: number;
  source: Vector2;
};

export type PhotoSliceGameState = {
  hiddenPolygon: Vector2[];
  revealedPolygons: Vector2[][];
  hazards: Hazard[];
  activeCut: ActiveCut | null;
  perimeterProgress: number;
  lives: number;
  status: "playing" | "won" | "lost";
  eventNonce: number;
  lastEvent: PhotoSliceGameEvent | null;
};

const EPSILON = 0.001;
const BOARD_SIZE = 1000;
const CUTTER_SPEED = 280;
const PERIMETER_SPEED = 220;
const HAZARD_BASE_SPEED = 124;
const HAZARD_RADIUS = 24;
const INITIAL_LIVES = 3;
const INITIAL_HAZARD_COUNT = 5;
const CUT_COLLISION_PADDING = 6;
const MAX_STEP_SECONDS = 0.1;
const SIMULATION_SLICE_SECONDS = 1 / 120;
const MIN_TURN_LATERAL_DISTANCE = 18;
const TURN_PREVIEW_DISTANCE = 140;
const MIN_TRAIL_CLEARANCE = 28;

const INITIAL_POLYGON: Vector2[] = [
  { x: 0, y: 0 },
  { x: BOARD_SIZE, y: 0 },
  { x: BOARD_SIZE, y: BOARD_SIZE },
  { x: 0, y: BOARD_SIZE },
];

const DIRECTION_VECTORS: Record<Direction, Vector2> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function createInitialGameState(initialHazardCount = INITIAL_HAZARD_COUNT): PhotoSliceGameState {
  return {
    hiddenPolygon: INITIAL_POLYGON,
    revealedPolygons: [],
    hazards: createHazards(initialHazardCount, INITIAL_POLYGON),
    activeCut: null,
    perimeterProgress: 0,
    lives: INITIAL_LIVES,
    status: "playing",
    eventNonce: 0,
    lastEvent: null,
  };
}

export function getBoardSize() {
  return BOARD_SIZE;
}

export function getCursorPosition(state: PhotoSliceGameState): Vector2 {
  if (state.activeCut) {
    return state.activeCut.head;
  }

  return getPerimeterPoint(state.hiddenPolygon, state.perimeterProgress);
}

export function getOpenPercent(state: PhotoSliceGameState): number {
  if (state.status === "won") {
    return 100;
  }

  const hiddenArea = polygonArea(state.hiddenPolygon);
  return Math.round((1 - hiddenArea / (BOARD_SIZE * BOARD_SIZE)) * 100);
}

export function stepGame(state: PhotoSliceGameState, deltaSeconds: number): PhotoSliceGameState {
  if (state.status !== "playing") {
    return state;
  }

  const dt = Math.min(Math.max(deltaSeconds, 0), MAX_STEP_SECONDS);
  const movedHazards = state.hazards.map((hazard) => moveHazard(hazard, state.hiddenPolygon, dt));

  if (!state.activeCut) {
    const perimeter = getPolygonPerimeter(state.hiddenPolygon);
    return {
      ...state,
      hazards: movedHazards,
      perimeterProgress: wrapProgress(state.perimeterProgress + PERIMETER_SPEED * dt, perimeter),
    };
  }

  const boundaryHit = getBoundaryHit(state.hiddenPolygon, state.activeCut.head, state.activeCut.direction);
  const stepDistance = CUTTER_SPEED * dt;
  const reachedBoundary = stepDistance + EPSILON >= boundaryHit.distance;
  const newHead = reachedBoundary
    ? boundaryHit.point
    : add(state.activeCut.head, scale(DIRECTION_VECTORS[state.activeCut.direction], stepDistance));
  const activeCut: ActiveCut = {
    ...state.activeCut,
    head: newHead,
  };
  const trail = getCutTrail(activeCut);

  if (!reachedBoundary) {
    if (movedHazards.some((hazard) => doesHazardHitTrail(hazard, trail))) {
      return applyCutFailure(state, movedHazards);
    }

    return {
      ...state,
      hazards: movedHazards,
      activeCut,
    };
  }

  const split = splitPolygonWithPath(state.hiddenPolygon, trail);
  if (!split) {
    return applyCutFailure(state, movedHazards);
  }

  const smallArea = polygonArea(split.first) <= polygonArea(split.second) ? split.first : split.second;
  const largeArea = smallArea === split.first ? split.second : split.first;
  const destroyedHazards = movedHazards.filter((hazard) => containsPoint(smallArea, hazard.position));
  const remainingHazards = movedHazards.filter((hazard) => !containsPoint(smallArea, hazard.position));

  if (remainingHazards.some((hazard) => doesHazardHitTrail(hazard, trail))) {
    return applyCutFailure(state, movedHazards);
  }

  const removalEvent =
    destroyedHazards.length > 0
      ? {
          type: "hazards-cleared" as const,
          count: destroyedHazards.length,
          source: averagePoints(destroyedHazards.map((hazard) => hazard.position)),
        }
      : null;

  if (remainingHazards.length === 0) {
    return {
      ...state,
      activeCut: null,
      hazards: [],
      hiddenPolygon: largeArea,
      revealedPolygons: [...state.revealedPolygons, smallArea],
      perimeterProgress: 0,
      status: "won",
      eventNonce: removalEvent ? state.eventNonce + 1 : state.eventNonce,
      lastEvent: removalEvent,
    };
  }

  return {
    ...state,
    activeCut: null,
    hazards: remainingHazards,
    hiddenPolygon: largeArea,
    revealedPolygons: [...state.revealedPolygons, smallArea],
    perimeterProgress: getPerimeterProgressAtPoint(largeArea, boundaryHit.point),
    eventNonce: removalEvent ? state.eventNonce + 1 : state.eventNonce,
    lastEvent: removalEvent,
  };
}

export function advanceGameState(state: PhotoSliceGameState, deltaSeconds: number): PhotoSliceGameState {
  let nextState = state;
  let remainingSeconds = Math.min(Math.max(deltaSeconds, 0), MAX_STEP_SECONDS);

  while (remainingSeconds > EPSILON) {
    const sliceSeconds = Math.min(remainingSeconds, SIMULATION_SLICE_SECONDS);
    nextState = stepGame(nextState, sliceSeconds);
    remainingSeconds -= sliceSeconds;

    if (nextState.status !== "playing") {
      break;
    }
  }

  return nextState;
}

export function startCut(state: PhotoSliceGameState, tapPoint: Vector2): PhotoSliceGameState {
  if (state.status !== "playing" || state.activeCut) {
    return state;
  }

  const cursor = getCursorPosition(state);
  const direction = chooseStartDirection(state.hiddenPolygon, cursor, tapPoint);
  if (!direction) {
    return state;
  }

  return {
    ...state,
    activeCut: {
      points: [cursor],
      head: cursor,
      direction,
    },
  };
}

export function requestTurn(state: PhotoSliceGameState, tapPoint: Vector2): PhotoSliceGameState {
  if (!state.activeCut || state.status !== "playing") {
    return state;
  }

  const nextDirection = chooseTurnDirection(state.hiddenPolygon, state.activeCut, tapPoint);
  if (!nextDirection || nextDirection === state.activeCut.direction) {
    return state;
  }

  return {
    ...state,
    activeCut: {
      points: [...state.activeCut.points, state.activeCut.head],
      head: state.activeCut.head,
      direction: nextDirection,
    },
  };
}

export function polygonToSvgPoints(points: Vector2[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

export function polylineToSvgPoints(points: Vector2[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

export function getCutTrail(activeCut: ActiveCut): Vector2[] {
  return [...activeCut.points, activeCut.head];
}

function applyCutFailure(state: PhotoSliceGameState, hazards: Hazard[]): PhotoSliceGameState {
  const nextLives = state.lives - 1;
  const failureSource = state.activeCut?.head ?? getCursorPosition(state);
  return {
    ...state,
    hazards,
    activeCut: null,
    lives: nextLives,
    status: nextLives <= 0 ? "lost" : "playing",
    eventNonce: state.eventNonce + 1,
    lastEvent: {
      type: "life-lost",
      count: 1,
      source: failureSource,
    },
  };
}

function createHazards(count: number, polygon: Vector2[]): Hazard[] {
  return Array.from({ length: count }, (_, index) => {
    const position = samplePointInsidePolygon(polygon);
    const angle = Math.random() * Math.PI * 2;
    const speed = HAZARD_BASE_SPEED + Math.random() * 42;

    return {
      id: index + 1,
      position,
      velocity: {
        x: Math.cos(angle) * speed,
        y: Math.sin(angle) * speed,
      },
      radius: HAZARD_RADIUS,
      angle: Math.random() * 360,
      spin: (Math.random() > 0.5 ? 1 : -1) * (90 + Math.random() * 160),
    };
  });
}

function moveHazard(hazard: Hazard, polygon: Vector2[], dt: number): Hazard {
  let velocityX = hazard.velocity.x;
  let velocityY = hazard.velocity.y;
  const trialX = {
    x: hazard.position.x + velocityX * dt,
    y: hazard.position.y,
  };

  if (!containsPoint(polygon, trialX)) {
    velocityX *= -1;
  }

  const trialY = {
    x: hazard.position.x,
    y: hazard.position.y + velocityY * dt,
  };

  if (!containsPoint(polygon, trialY)) {
    velocityY *= -1;
  }

  const nextPosition = {
    x: hazard.position.x + velocityX * dt,
    y: hazard.position.y + velocityY * dt,
  };

  if (!containsPoint(polygon, nextPosition)) {
    velocityX *= -1;
    velocityY *= -1;
  }

  const correctedPosition = {
    x: hazard.position.x + velocityX * dt,
    y: hazard.position.y + velocityY * dt,
  };

  return {
    ...hazard,
    position: containsPoint(polygon, correctedPosition) ? correctedPosition : hazard.position,
    velocity: {
      x: velocityX,
      y: velocityY,
    },
    angle: (hazard.angle + hazard.spin * dt) % 360,
  };
}

function chooseStartDirection(polygon: Vector2[], cursor: Vector2, tapPoint: Vector2): Direction | null {
  const directions = (Object.keys(DIRECTION_VECTORS) as Direction[])
    .map((direction) => ({
      direction,
      score: dot(subtract(tapPoint, cursor), DIRECTION_VECTORS[direction]),
      probe: add(cursor, scale(DIRECTION_VECTORS[direction], 12)),
    }))
    .filter((candidate) => containsPointStrictlyInside(polygon, candidate.probe))
    .sort((left, right) => right.score - left.score);

  return directions[0]?.direction ?? null;
}

function chooseTurnDirection(polygon: Vector2[], activeCut: ActiveCut, tapPoint: Vector2): Direction | null {
  const [firstTurn, secondTurn] = getPerpendicularDirections(activeCut.direction);
  const relative = subtract(tapPoint, activeCut.head);
  const lateralDelta =
    activeCut.direction === "up" || activeCut.direction === "down" ? relative.x : relative.y;

  if (Math.abs(lateralDelta) <= MIN_TURN_LATERAL_DISTANCE) {
    return null;
  }

  const preferredDirection = pickPreferredTurnDirection(activeCut.direction, lateralDelta, firstTurn, secondTurn);
  const probe = add(activeCut.head, scale(DIRECTION_VECTORS[preferredDirection], 12));

  if (containsPoint(polygon, probe) && isTurnPreviewClear(polygon, activeCut, preferredDirection)) {
    return preferredDirection;
  }

  return null;
}

function isTurnPreviewClear(polygon: Vector2[], activeCut: ActiveCut, nextDirection: Direction): boolean {
  const boundaryHit = getBoundaryHit(polygon, activeCut.head, nextDirection);
  const previewDistance = Math.min(boundaryHit.distance, TURN_PREVIEW_DISTANCE);
  const previewEnd = add(activeCut.head, scale(DIRECTION_VECTORS[nextDirection], previewDistance));
  const trail = getCutTrail(activeCut);

  for (let index = 0; index < trail.length - 2; index += 1) {
    if (distanceBetweenSegments(activeCut.head, previewEnd, trail[index], trail[index + 1]) < MIN_TRAIL_CLEARANCE) {
      return false;
    }
  }

  return true;
}

function pickPreferredTurnDirection(
  direction: Direction,
  lateralDelta: number,
  firstTurn: Direction,
  secondTurn: Direction,
): Direction {
  switch (direction) {
    case "up":
    case "down":
      return lateralDelta < 0 ? "left" : "right";
    case "left":
    case "right":
      return lateralDelta < 0 ? "up" : "down";
  }
}

function getPerpendicularDirections(direction: Direction): [Direction, Direction] {
  switch (direction) {
    case "up":
    case "down":
      return ["left", "right"];
    case "left":
    case "right":
      return ["up", "down"];
  }
}

function getBoundaryHit(polygon: Vector2[], origin: Vector2, direction: Direction): { point: Vector2; distance: number } {
  const directionVector = DIRECTION_VECTORS[direction];
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestPoint = origin;

  for (const [start, end] of getEdges(polygon)) {
    if (Math.abs(start.x - end.x) < EPSILON) {
      if (Math.abs(directionVector.x) < EPSILON) {
        continue;
      }
      if (!isBetween(origin.y, start.y, end.y)) {
        continue;
      }
      const candidateDistance = (start.x - origin.x) / directionVector.x;
      if (candidateDistance <= EPSILON || candidateDistance >= bestDistance) {
        continue;
      }
      const midpoint = add(origin, scale(directionVector, candidateDistance / 2));
      if (!containsPointStrictlyInside(polygon, midpoint)) {
        continue;
      }
      bestDistance = candidateDistance;
      bestPoint = { x: start.x, y: origin.y };
    } else {
      if (Math.abs(directionVector.y) < EPSILON) {
        continue;
      }
      if (!isBetween(origin.x, start.x, end.x)) {
        continue;
      }
      const candidateDistance = (start.y - origin.y) / directionVector.y;
      if (candidateDistance <= EPSILON || candidateDistance >= bestDistance) {
        continue;
      }
      const midpoint = add(origin, scale(directionVector, candidateDistance / 2));
      if (!containsPointStrictlyInside(polygon, midpoint)) {
        continue;
      }
      bestDistance = candidateDistance;
      bestPoint = { x: origin.x, y: start.y };
    }
  }

  return {
    point: bestPoint,
    distance: Number.isFinite(bestDistance) ? bestDistance : 0,
  };
}

function splitPolygonWithPath(polygon: Vector2[], path: Vector2[]): { first: Vector2[]; second: Vector2[] } | null {
  if (path.length < 2) {
    return null;
  }

  const normalizedPath = simplifyPolygon(path);
  const start = normalizedPath[0];
  const end = normalizedPath[normalizedPath.length - 1];
  const polygonWithPoints = insertBoundaryPoints(polygon, start, end);
  const startIndex = polygonWithPoints.findIndex((point) => pointsEqual(point, start));
  const endIndex = polygonWithPoints.findIndex((point) => pointsEqual(point, end));

  if (startIndex === -1 || endIndex === -1 || startIndex === endIndex) {
    return null;
  }

  const forwardArc = walkPolygon(polygonWithPoints, startIndex, endIndex);
  const backwardArc = walkPolygon(polygonWithPoints, endIndex, startIndex);
  const first = simplifyPolygon([...normalizedPath, ...backwardArc.slice(1, -1)]);
  const second = simplifyPolygon([...normalizedPath.slice().reverse(), ...forwardArc.slice(1, -1)]);

  if (first.length < 3 || second.length < 3 || polygonArea(first) < 1 || polygonArea(second) < 1) {
    return null;
  }

  return { first, second };
}

function insertBoundaryPoints(polygon: Vector2[], firstPoint: Vector2, secondPoint: Vector2): Vector2[] {
  const result: Vector2[] = [];
  const targets = [firstPoint, secondPoint];

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    result.push(current);

    const inserts = targets
      .filter((point) => isPointOnSegment(point, current, next) && !pointsEqual(point, current) && !pointsEqual(point, next))
      .sort((left, right) => distance(current, left) - distance(current, right));

    for (const point of inserts) {
      if (!result.some((existing) => pointsEqual(existing, point))) {
        result.push(point);
      }
    }
  }

  return result;
}

function walkPolygon(polygon: Vector2[], startIndex: number, endIndex: number): Vector2[] {
  const result: Vector2[] = [polygon[startIndex]];
  let index = startIndex;

  while (index !== endIndex) {
    index = (index + 1) % polygon.length;
    result.push(polygon[index]);
  }

  return result;
}

function getPerimeterPoint(polygon: Vector2[], progress: number): Vector2 {
  const perimeter = getPolygonPerimeter(polygon);
  let remaining = wrapProgress(progress, perimeter);

  for (const [start, end] of getEdges(polygon)) {
    const segmentLength = distance(start, end);
    if (remaining <= segmentLength) {
      return {
        x: start.x + ((end.x - start.x) * remaining) / segmentLength,
        y: start.y + ((end.y - start.y) * remaining) / segmentLength,
      };
    }
    remaining -= segmentLength;
  }

  return polygon[0];
}

function getPerimeterProgressAtPoint(polygon: Vector2[], point: Vector2): number {
  let progress = 0;

  for (const [start, end] of getEdges(polygon)) {
    if (isPointOnSegment(point, start, end)) {
      return progress + distance(start, point);
    }
    progress += distance(start, end);
  }

  return 0;
}

function getPolygonPerimeter(polygon: Vector2[]): number {
  return getEdges(polygon).reduce((sum, [start, end]) => sum + distance(start, end), 0);
}

function getEdges(polygon: Vector2[]): Array<[Vector2, Vector2]> {
  return polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]);
}

function polygonArea(points: Vector2[]): number {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return Math.abs(area) / 2;
}

function samplePointInsidePolygon(polygon: Vector2[]): Vector2 {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const point = {
      x: 80 + Math.random() * (BOARD_SIZE - 160),
      y: 80 + Math.random() * (BOARD_SIZE - 160),
    };

    if (containsPoint(polygon, point)) {
      return point;
    }
  }

  return { x: BOARD_SIZE / 2, y: BOARD_SIZE / 2 };
}

function simplifyPolygon(points: Vector2[]): Vector2[] {
  const unique = points.filter((point, index, array) => {
    const previous = array[(index - 1 + array.length) % array.length];
    return index === 0 || !pointsEqual(point, previous);
  });

  const simplified = unique.filter((point, index, array) => {
    const previous = array[(index - 1 + array.length) % array.length];
    const next = array[(index + 1) % array.length];
    return !isCollinear(previous, point, next);
  });

  return simplified.length >= 3 ? simplified : unique;
}

function containsPoint(polygon: Vector2[], point: Vector2): boolean {
  if (polygon.some((vertex, index) => isPointOnSegment(point, vertex, polygon[(index + 1) % polygon.length]))) {
    return true;
  }

  let inside = false;

  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y + EPSILON) + current.x;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function containsPointStrictlyInside(polygon: Vector2[], point: Vector2): boolean {
  if (!containsPoint(polygon, point)) {
    return false;
  }

  return !polygon.some((vertex, index) => isPointOnSegment(point, vertex, polygon[(index + 1) % polygon.length]));
}

function doesHazardHitTrail(hazard: Hazard, trail: Vector2[]): boolean {
  for (let index = 0; index < trail.length - 1; index += 1) {
    if (distanceToSegment(hazard.position, trail[index], trail[index + 1]) <= hazard.radius + CUT_COLLISION_PADDING) {
      return true;
    }
  }

  return false;
}

function distanceToSegment(point: Vector2, start: Vector2, end: Vector2): number {
  const segment = subtract(end, start);
  const segmentLengthSquared = segment.x * segment.x + segment.y * segment.y;

  if (segmentLengthSquared <= EPSILON) {
    return distance(point, start);
  }

  const t = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / segmentLengthSquared));
  const projection = {
    x: start.x + segment.x * t,
    y: start.y + segment.y * t,
  };

  return distance(point, projection);
}

function distanceBetweenSegments(firstStart: Vector2, firstEnd: Vector2, secondStart: Vector2, secondEnd: Vector2): number {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
    return 0;
  }

  return Math.min(
    distanceToSegment(firstStart, secondStart, secondEnd),
    distanceToSegment(firstEnd, secondStart, secondEnd),
    distanceToSegment(secondStart, firstStart, firstEnd),
    distanceToSegment(secondEnd, firstStart, firstEnd),
  );
}

function segmentsIntersect(firstStart: Vector2, firstEnd: Vector2, secondStart: Vector2, secondEnd: Vector2): boolean {
  const firstCrossStart = signedArea(firstStart, firstEnd, secondStart);
  const firstCrossEnd = signedArea(firstStart, firstEnd, secondEnd);
  const secondCrossStart = signedArea(secondStart, secondEnd, firstStart);
  const secondCrossEnd = signedArea(secondStart, secondEnd, firstEnd);

  if (Math.abs(firstCrossStart) <= EPSILON && isPointOnSegment(secondStart, firstStart, firstEnd)) {
    return true;
  }

  if (Math.abs(firstCrossEnd) <= EPSILON && isPointOnSegment(secondEnd, firstStart, firstEnd)) {
    return true;
  }

  if (Math.abs(secondCrossStart) <= EPSILON && isPointOnSegment(firstStart, secondStart, secondEnd)) {
    return true;
  }

  if (Math.abs(secondCrossEnd) <= EPSILON && isPointOnSegment(firstEnd, secondStart, secondEnd)) {
    return true;
  }

  return (firstCrossStart > 0) !== (firstCrossEnd > 0) && (secondCrossStart > 0) !== (secondCrossEnd > 0);
}

function signedArea(origin: Vector2, left: Vector2, right: Vector2): number {
  return (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
}

function isCollinear(previous: Vector2, current: Vector2, next: Vector2): boolean {
  return Math.abs((current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x)) <= EPSILON;
}

function isPointOnSegment(point: Vector2, start: Vector2, end: Vector2): boolean {
  const withinBounds =
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.x >= Math.min(start.x, end.x) - EPSILON &&
    point.y <= Math.max(start.y, end.y) + EPSILON &&
    point.y >= Math.min(start.y, end.y) - EPSILON;

  if (!withinBounds) {
    return false;
  }

  const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
  return Math.abs(cross) <= EPSILON;
}

function isBetween(value: number, boundA: number, boundB: number): boolean {
  return value >= Math.min(boundA, boundB) - EPSILON && value <= Math.max(boundA, boundB) + EPSILON;
}

function pointsEqual(left: Vector2, right: Vector2): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.y - right.y) <= EPSILON;
}

function add(left: Vector2, right: Vector2): Vector2 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
  };
}

function subtract(left: Vector2, right: Vector2): Vector2 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
  };
}

function scale(vector: Vector2, factor: number): Vector2 {
  return {
    x: vector.x * factor,
    y: vector.y * factor,
  };
}

function dot(left: Vector2, right: Vector2): number {
  return left.x * right.x + left.y * right.y;
}

function distance(left: Vector2, right: Vector2): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function wrapProgress(progress: number, perimeter: number): number {
  if (perimeter <= EPSILON) {
    return 0;
  }

  return ((progress % perimeter) + perimeter) % perimeter;
}

function averagePoints(points: Vector2[]): Vector2 {
  if (points.length === 0) {
    return { x: BOARD_SIZE / 2, y: BOARD_SIZE / 2 };
  }

  const sum = points.reduce(
    (accumulator, point) => ({
      x: accumulator.x + point.x,
      y: accumulator.y + point.y,
    }),
    { x: 0, y: 0 },
  );

  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
  };
}