export interface DrainSignal {
  isDraining: () => boolean;
  startDraining: () => void;
}

/** Wire `startDraining` to SIGTERM in the service; this package never touches `process`. */
export function createDrainSignal(): DrainSignal {
  let draining = false;
  return {
    isDraining: () => draining,
    startDraining: () => {
      draining = true;
    },
  };
}
