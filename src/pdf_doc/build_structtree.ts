import type { InternalCtx } from './types.js'
import type { StructNode } from '../types/index.js'
import { isMcrRef } from '../types/index.js'
import { toPdfName } from './utils.js'

// D3 (tagged PDF): /StructTreeRoot + one /StructElem object per real
// StructNode + a /ParentTree number tree mapping each page's own
// /StructParents index to an array of StructElem refs, indexed by MCID.
// Returns the /StructTreeRoot object id, or null when there's nothing
// tagged (taggedPdf off, or a document with no taggable content at all).
export function putStructTree(ctx: InternalCtx): number | null {
  const root = ctx.structRoot
  if (!root || root.kids.length === 0) return null

  // Pre-pass: allocate every real StructNode's object id up front. A
  // node's own /K array needs its children's ids and a child's /P needs
  // its parent's id — indirect references don't care about write order,
  // but the ID NUMBERS themselves must already exist before any body is
  // written, so this mirrors how pageObjIds/contentObjIds are pre-allocated
  // in build_pages.ts.
  const ids = new Map<StructNode, number>()
  const assign = (node: StructNode): void => {
    ids.set(node, ctx.newObjectDeferred())
    for (const kid of node.kids) if (!isMcrRef(kid)) assign(kid)
  }
  for (const kid of root.kids) if (!isMcrRef(kid)) assign(kid)

  const structTreeRootId = ctx.newObjectDeferred()

  // page (1-based) -> StructElem id array, indexed by that page's own mcid
  const perPage = new Map<number, number[]>()

  const writeNode = (node: StructNode, parentRef: string): void => {
    const id = ids.get(node)!
    const kidStrs: string[] = []
    for (const kid of node.kids) {
      if (isMcrRef(kid)) {
        const pageRef = ctx.pageObjIds[kid.page - 1]
        kidStrs.push(`<< /Type /MCR /Pg ${pageRef} 0 R /MCID ${kid.mcid} >>`)
        let arr = perPage.get(kid.page)
        if (!arr) { arr = []; perPage.set(kid.page, arr) }
        arr[kid.mcid] = id
      } else {
        kidStrs.push(`${ids.get(kid)} 0 R`)
      }
    }

    ctx.newObjectDeferredBegin(id, true)
    ctx.out('<<')
    ctx.out('/Type /StructElem')
    ctx.out(`/S /${toPdfName(node.tag)}`)
    ctx.out(`/P ${parentRef}`)
    ctx.out(kidStrs.length === 1 ? `/K ${kidStrs[0]}` : `/K [${kidStrs.join(' ')}]`)
    if (node.alt)  ctx.out(`/Alt ${ctx.strLit(node.alt)}`)
    if (node.lang) ctx.out(`/Lang ${ctx.strLit(node.lang)}`)
    ctx.out('>>')
    ctx.out('endobj')

    for (const kid of node.kids) if (!isMcrRef(kid)) writeNode(kid, `${id} 0 R`)
  }

  const topKids: string[] = []
  for (const kid of root.kids) {
    // a bare MCR directly under the sentinel root can't happen —
    // tagStructContent only ever attaches content to a real StructNode
    if (isMcrRef(kid)) continue
    writeNode(kid, `${structTreeRootId} 0 R`)
    topKids.push(`${ids.get(kid)} 0 R`)
  }

  const numsParts: string[] = []
  for (const [page, arr] of [...perPage.entries()].sort((a, b) => a[0] - b[0])) {
    const arrId = ctx.newObjectDeferred()
    ctx.newObjectDeferredBegin(arrId, true)
    ctx.out(`[${arr.map(id => id === undefined ? 'null' : `${id} 0 R`).join(' ')}]`)
    ctx.out('endobj')
    // /StructParents is 0-based per page (build_pages.ts assigns it as the
    // page's own array index), matching the ParentTree's own key convention
    numsParts.push(`${page - 1} ${arrId} 0 R`)
  }
  const parentTreeId = ctx.newObjectDeferred()
  ctx.newObjectDeferredBegin(parentTreeId, true)
  ctx.out(`<< /Nums [${numsParts.join(' ')}] >>`)
  ctx.out('endobj')

  ctx.newObjectDeferredBegin(structTreeRootId, true)
  ctx.out('<<')
  ctx.out('/Type /StructTreeRoot')
  ctx.out(`/K [${topKids.join(' ')}]`)
  ctx.out(`/ParentTree ${parentTreeId} 0 R`)
  ctx.out(`/ParentTreeNextKey ${ctx.pageObjIds.length}`)
  ctx.out('>>')
  ctx.out('endobj')

  return structTreeRootId
}
