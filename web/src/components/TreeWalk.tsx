"use client";

import { useMemo, useState } from "react";

import styles from "./TreeWalk.module.css";

/**
 * The prefix walk, drawn.
 *
 * Deciding whether a slot won means knowing the combined weight of everyone ordered
 * before it. Summing them one by one would be O(n) encrypted additions; the tree answers
 * it by climbing from the leaf and picking up whole pre-summed subtrees on the way.
 *
 * This draws that climb for a chosen slot. It is a *sum* tree, not a Merkle tree - the
 * shaded siblings are added together, not hashed, and there is no proof or authentication
 * path here. Calling it one would borrow credibility from a mechanism the contract does
 * not use.
 *
 * The depth shown is the real one: the tree only walks as far as the highest node covering
 * the slots in use, so a small pool genuinely has a shallow tree.
 */
export function TreeWalk({ slotsUsed }: { slotsUsed: number }) {
  const depth = useMemo(() => {
    if (slotsUsed <= 1) return 1;
    let d = 0;
    let span = 1;
    while (span < slotsUsed) {
      span <<= 1;
      d++;
    }
    // Past five levels the drawing stops being readable; the walk is still correct.
    return Math.min(d, 5);
  }, [slotsUsed]);

  const leaves = 1 << depth;
  const [picked, setPicked] = useState(() => Math.min(1, leaves - 1));

  /**
   * Which nodes the walk touches.
   *
   * Climbing from the leaf, a *right* child means everything under its left sibling is
   * ordered before you - so that whole subtree is added in one go. A left child adds
   * nothing: its sibling sits after you.
   */
  const { onPath, summed } = useMemo(() => {
    const path = new Set<number>();
    const adds = new Set<number>();

    let node = leaves + picked;
    path.add(node);

    while (node > 1) {
      if (node % 2 === 1) adds.add(node - 1);
      node = Math.floor(node / 2);
      path.add(node);
    }

    return { onPath: path, summed: adds };
  }, [picked, leaves]);

  const levels = Array.from({ length: depth + 1 }, (_, level) => {
    const first = 1 << level;
    return Array.from({ length: first }, (_, i) => first + i);
  });

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.rootLabel}>ROOT · POOL TOTAL</span>
        <span className={styles.legend}>
          <span className={styles.key}>
            <span className={`${styles.dot} ${styles.dotPath}`} /> ON YOUR PATH
          </span>
          <span className={styles.key}>
            <span className={`${styles.dot} ${styles.dotAdd}`} /> SUMMED INTO YOUR BAND
          </span>
          <span className={styles.key}>
            <span className={`${styles.dot} ${styles.dotOther}`} /> EVERYONE ELSE
          </span>
        </span>
      </div>

      <div className={styles.tree}>
        {levels.map((row, level) => (
          <div key={level} className={styles.row}>
            {row.map((node) => {
              const isLeaf = level === depth;
              const slot = isLeaf ? node - leaves : undefined;
              const used = slot === undefined || slot < slotsUsed;

              const cls = onPath.has(node)
                ? `${styles.node} ${styles.nodePath}`
                : summed.has(node)
                  ? `${styles.node} ${styles.nodeAdd}`
                  : `${styles.node} ${!used ? styles.nodeEmpty : ""}`;

              return (
                <button
                  key={node}
                  className={cls}
                  onClick={() => isLeaf && used && setPicked(slot!)}
                  disabled={!isLeaf || !used}
                  title={
                    isLeaf
                      ? used
                        ? `Slot ${slot}`
                        : `Slot ${slot} - empty`
                      : `Node ${node} - the combined weight of ${1 << (depth - level)} slots`
                  }
                >
                  {isLeaf && used ? slot : ""}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className={styles.readout}>
        <div className={styles.cell}>
          <span className={styles.cellLabel}>SELECTED SLOT</span>
          <span className={styles.cellValue}>{picked}</span>
        </div>
        <div className={styles.cell}>
          <span className={styles.cellLabel}>SUBTREES SUMMED</span>
          <span className={styles.cellValue}>{summed.size}</span>
        </div>
        <div className={styles.cell}>
          <span className={styles.cellLabel}>INSTEAD OF</span>
          <span className={styles.cellValue}>{picked}</span>
        </div>
        <div className={styles.cell}>
          <span className={styles.cellLabel}>TREE DEPTH</span>
          <span className={styles.cellValue}>{depth}</span>
        </div>
      </div>

      <p className={styles.note}>
        To place slot {picked}&apos;s band, the contract needs the combined weight of the {picked} slot
        {picked === 1 ? "" : "s"} before it. Rather than adding {picked} figures it adds {summed.size} already-summed
        subtree{summed.size === 1 ? "" : "s"} - that is the whole reason for the tree, and the saving grows as the pool
        does. Every value shaded here is a ciphertext; the shape is public, the numbers are not.
      </p>
    </div>
  );
}
