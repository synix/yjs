import * as t from 'lib0/testing'
import { ContentString, ID, Item, createID } from 'yjs'

/**
 * @param {t.TestCase} _tc
 */
export const testItemStruct = _tc => {
  const item = new Item(
    createID(1, 0), // item id contain client id and clock
    null, // left
    null, // origin
    null, // right
    null, // right origin
    null, // parent
    null, // parentSub
    new ContentString('hello world!'), // content
  )

  t.compareObjects(item.id, createID(1, 0))
  t.compareObjects(item.content, new ContentString('hello world!')) 
}