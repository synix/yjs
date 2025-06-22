import {
  GC,
  getState,
  AbstractStruct,
  replaceStruct,
  addStruct,
  addToDeleteSet,
  findRootTypeKey,
  compareIDs,
  getItem,
  getItemCleanEnd,
  getItemCleanStart,
  readContentDeleted,
  readContentBinary,
  readContentJSON,
  readContentAny,
  readContentString,
  readContentEmbed,
  readContentDoc,
  createID,
  readContentFormat,
  readContentType,
  addChangedTypeToTransaction,
  isDeleted,
  StackItem, DeleteSet, UpdateDecoderV1, UpdateDecoderV2, UpdateEncoderV1, UpdateEncoderV2, ContentType, ContentDeleted, StructStore, ID, AbstractType, Transaction // eslint-disable-line
} from '../internals.js'

import * as error from 'lib0/error'
import * as binary from 'lib0/binary'
import * as array from 'lib0/array'

/**
 * @todo This should return several items
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {{item:Item, diff:number}}
 */
export const followRedone = (store, id) => {
  /**
   * @type {ID|null}
   */
  let nextID = id
  let diff = 0
  let item
  do {
    if (diff > 0) {
      nextID = createID(nextID.client, nextID.clock + diff)
    }
    item = getItem(store, nextID)
    diff = nextID.clock - item.id.clock
    nextID = item.redone
  } while (nextID !== null && item instanceof Item)
  return {
    item, diff
  }
}

/**
 * Make sure that neither item nor any of its parents is ever deleted.
 *
 * This property does not persist when storing it into a database or when
 * sending it to other peers
 *
 * @param {Item|null} item
 * @param {boolean} keep
 */
export const keepItem = (item, keep) => {
  while (item !== null && item.keep !== keep) {
    item.keep = keep
    item = /** @type {AbstractType<any>} */ (item.parent)._item
  }
}

/**
 * Split leftItem into two items
 * @param {Transaction} transaction
 * @param {Item} leftItem
 * @param {number} diff
 * @return {Item}
 *
 * @function
 * @private
 */
export const splitItem = (transaction, leftItem, diff) => {
  // create rightItem
  const { client, clock } = leftItem.id
  const rightItem = new Item(
    createID(client, clock + diff),
    leftItem,
    createID(client, clock + diff - 1),
    leftItem.right,
    leftItem.rightOrigin,
    leftItem.parent,
    leftItem.parentSub,
    leftItem.content.splice(diff)
  )
  if (leftItem.deleted) {
    rightItem.markDeleted()
  }
  if (leftItem.keep) {
    rightItem.keep = true
  }
  if (leftItem.redone !== null) {
    rightItem.redone = createID(leftItem.redone.client, leftItem.redone.clock + diff)
  }
  // update left (do not set leftItem.rightOrigin as it will lead to problems when syncing)
  leftItem.right = rightItem
  // update right
  if (rightItem.right !== null) {
    rightItem.right.left = rightItem
  }
  // right is more specific.
  transaction._mergeStructs.push(rightItem)
  // update parent._map
  if (rightItem.parentSub !== null && rightItem.right === null) {
    /** @type {AbstractType<any>} */ (rightItem.parent)._map.set(rightItem.parentSub, rightItem)
  }
  leftItem.length = diff
  return rightItem
}

/**
 * @param {Array<StackItem>} stack
 * @param {ID} id
 */
const isDeletedByUndoStack = (stack, id) => array.some(stack, /** @param {StackItem} s */ s => isDeleted(s.deletions, id))

/**
 * Redoes the effect of this operation.
 *
 * @param {Transaction} transaction The Yjs instance.
 * @param {Item} item
 * @param {Set<Item>} redoitems
 * @param {DeleteSet} itemsToDelete
 * @param {boolean} ignoreRemoteMapChanges
 * @param {import('../utils/UndoManager.js').UndoManager} um
 *
 * @return {Item|null}
 *
 * @private
 */
export const redoItem = (transaction, item, redoitems, itemsToDelete, ignoreRemoteMapChanges, um) => {
  const doc = transaction.doc
  const store = doc.store
  const ownClientID = doc.clientID
  const redone = item.redone
  if (redone !== null) {
    return getItemCleanStart(transaction, redone)
  }
  let parentItem = /** @type {AbstractType<any>} */ (item.parent)._item
  /**
   * @type {Item|null}
   */
  let left = null
  /**
   * @type {Item|null}
   */
  let right
  // make sure that parent is redone
  if (parentItem !== null && parentItem.deleted === true) {
    // try to undo parent if it will be undone anyway
    if (parentItem.redone === null && (!redoitems.has(parentItem) || redoItem(transaction, parentItem, redoitems, itemsToDelete, ignoreRemoteMapChanges, um) === null)) {
      return null
    }
    while (parentItem.redone !== null) {
      parentItem = getItemCleanStart(transaction, parentItem.redone)
    }
  }
  const parentType = parentItem === null ? /** @type {AbstractType<any>} */ (item.parent) : /** @type {ContentType} */ (parentItem.content).type

  if (item.parentSub === null) {
    // Is an array item. Insert at the old position
    left = item.left
    right = item
    // find next cloned_redo items
    while (left !== null) {
      /**
       * @type {Item|null}
       */
      let leftTrace = left
      // trace redone until parent matches
      while (leftTrace !== null && /** @type {AbstractType<any>} */ (leftTrace.parent)._item !== parentItem) {
        leftTrace = leftTrace.redone === null ? null : getItemCleanStart(transaction, leftTrace.redone)
      }
      if (leftTrace !== null && /** @type {AbstractType<any>} */ (leftTrace.parent)._item === parentItem) {
        left = leftTrace
        break
      }
      left = left.left
    }
    while (right !== null) {
      /**
       * @type {Item|null}
       */
      let rightTrace = right
      // trace redone until parent matches
      while (rightTrace !== null && /** @type {AbstractType<any>} */ (rightTrace.parent)._item !== parentItem) {
        rightTrace = rightTrace.redone === null ? null : getItemCleanStart(transaction, rightTrace.redone)
      }
      if (rightTrace !== null && /** @type {AbstractType<any>} */ (rightTrace.parent)._item === parentItem) {
        right = rightTrace
        break
      }
      right = right.right
    }
  } else {
    right = null
    if (item.right && !ignoreRemoteMapChanges) {
      left = item
      // Iterate right while right is in itemsToDelete
      // If it is intended to delete right while item is redone, we can expect that item should replace right.
      while (left !== null && left.right !== null && (left.right.redone || isDeleted(itemsToDelete, left.right.id) || isDeletedByUndoStack(um.undoStack, left.right.id) || isDeletedByUndoStack(um.redoStack, left.right.id))) {
        left = left.right
        // follow redone
        while (left.redone) left = getItemCleanStart(transaction, left.redone)
      }
      if (left && left.right !== null) {
        // It is not possible to redo this item because it conflicts with a
        // change from another client
        return null
      }
    } else {
      left = parentType._map.get(item.parentSub) || null
    }
  }
  const nextClock = getState(store, ownClientID)
  const nextId = createID(ownClientID, nextClock)
  const redoneItem = new Item(
    nextId,
    left, left && left.lastId,
    right, right && right.id,
    parentType,
    item.parentSub,
    item.content.copy()
  )
  item.redone = nextId
  keepItem(redoneItem, true)
  redoneItem.integrate(transaction, 0)
  return redoneItem
}

/**
 * Abstract class that represents any content.
 */
export class Item extends AbstractStruct {
  /**
   * @param {ID} id
   * @param {Item | null} left
   * @param {ID | null} origin
   * @param {Item | null} right
   * @param {ID | null} rightOrigin
   * @param {AbstractType<any>|ID|null} parent Is a type if integrated, is null if it is possible to copy parent from left or right, is ID before integration to search for it.
   * @param {string | null} parentSub
   * @param {AbstractContent} content
   */
  constructor (id, left, origin, right, rightOrigin, parent, parentSub, content) {
    super(id, content.getLength())

    // left/right是指针, 指向的是真实存在的Item对象
    // origin/rightOrigin是ID, 并不一定和真实的Item对象挂钩

    /**
     * The item that was originally to the left of this item.
     * @type {ID | null}
     */
    this.origin = origin
    /**
     * The item that is currently to the left of this item.
     * @type {Item | null}
     */
    this.left = left
    /**
     * The item that is currently to the right of this item.
     * @type {Item | null}
     */
    this.right = right
    /**
     * The item that was originally to the right of this item.
     * @type {ID | null}
     */
    this.rightOrigin = rightOrigin

    /**
     * @type {AbstractType<any>|ID|null}
     * 
     * parent这么多可能的类型，都对应什么情况呢?
     * 
     */
    this.parent = parent

    /**
     * If the parent refers to this item with some kind of key (e.g. YMap, the
     * key is specified here. The key is then used to refer to the list in which
     * to insert this item. If `parentSub = null` type._start is the list in
     * which to insert to. Otherwise it is `parent._map`.
     * 
     * parentSub用来存储YMap的key, content则是存储YMap的value
     * 
     * @type {String | null}
     */
    this.parentSub = parentSub

    /**
     * If this type's effect is redone this type refers to the type that undid
     * this operation.
     * @type {ID | null}
     */
    this.redone = null

    /**
     * @type {AbstractContent}
     * 如果content类型是ContentType，则content负责维护Item和YType一对一的关系
     */
    this.content = content

    /**
     * bit1: keep
     * bit2: countable
     * bit3: deleted
     * bit4: mark - mark node as fast-search-marker
     * @type {number} byte
     */
    this.info = this.content.isCountable() ? binary.BIT2 : 0
  }

  /**
   * This is used to mark the item as an indexed fast-search marker
   * 表示这个item被缓存在YType的serach marker里了😠
   *
   * @type {boolean}
   */
  set marker (isMarked) {
    if (((this.info & binary.BIT4) > 0) !== isMarked) {
      this.info ^= binary.BIT4
    }
  }

  get marker () {
    return (this.info & binary.BIT4) > 0
  }

  /**
   * If true, do not garbage collect this Item.
   * 
   * 表示tryGcDeleteSet()在回收Item对象时，是否抗拒被回收
   */
  get keep () {
    return (this.info & binary.BIT1) > 0
  }

  set keep (doKeep) {
    if (this.keep !== doKeep) {
      this.info ^= binary.BIT1
    }
  }

  // countable为true, 表示这个Item的length是要计入的
  get countable () {
    return (this.info & binary.BIT2) > 0
  }

  /**
   * Whether this item was deleted or not.
   * @type {Boolean}
   */
  get deleted () {
    return (this.info & binary.BIT3) > 0
  }

  set deleted (doDelete) {
    if (this.deleted !== doDelete) {
      this.info ^= binary.BIT3
    }
  }

  markDeleted () {
    this.info |= binary.BIT3
  }

  /**
   * Return the creator clientID of the missing op or define missing items and return null.
   * 
   * 返回的是一个client id或者null，代表把Item对象integrate到本地Doc时，哪个client id的数据是缺失的
   * 而这个client id来自于3个方面: 这个Item对象的origin/rightOrigin/parent
   *
   * @param {Transaction} transaction
   * @param {StructStore} store
   * @return {null | number}
   */
  getMissing (transaction, store) {
    // 调用getMissing()方法时, 因为Item对象是remote传入的，所以其origin和rightOrigin是在remote端插入时写入的, 而left/right是未定义的
    if (this.origin && this.origin.client !== this.id.client && this.origin.clock >= getState(store, this.origin.client)) {
      // 当前Item对象的client id不等于其origin的client id, 并且其origin的clock大于本地的，说明其origin所对应client id的数据在本地doc(本地StructStore)是有缺失的
      return this.origin.client
    }
    if (this.rightOrigin && this.rightOrigin.client !== this.id.client && this.rightOrigin.clock >= getState(store, this.rightOrigin.client)) {
      // 当前Item对象的client id不等于其rightOrigin的client id, 并且其rightOrigin的clock大于本地的，说明其rightOrigin所对应的client id的数据在本地doc(本地StructStore)是有缺失的
      return this.rightOrigin.client
    }

    if (this.parent && this.parent.constructor === ID && this.id.client !== this.parent.client && this.parent.clock >= getState(store, this.parent.client)) {
      // 当前Item对象的client id不等于其parent的client id, 并且其parent的clock大于本地的，说明其parent所对应的client id的数据在本地doc(本地StructStore)是有缺失的
      return this.parent.client
    }

    // We have all missing ids, now find the items

    // 给Item对象的left/right赋值, 给origin/rightOrigin重新赋值
    if (this.origin) {
      this.left = getItemCleanEnd(transaction, store, this.origin)
      this.origin = this.left.lastId
    }

    if (this.rightOrigin) {
      this.right = getItemCleanStart(transaction, this.rightOrigin)
      this.rightOrigin = this.right.id
    }

    // 给Item对象的parent赋值
    if ((this.left && this.left.constructor === GC) || (this.right && this.right.constructor === GC)) {
      // 这是为什么呢???
      this.parent = null
    } else if (!this.parent) {
      // only set parent if this shouldn't be garbage collected

      // 把此Item对象的parent/parentSub设置成left或者right指针的
      if (this.left && this.left.constructor === Item) {
        this.parent = this.left.parent
        this.parentSub = this.left.parentSub
      } else if (this.right && this.right.constructor === Item) {
        this.parent = this.right.parent
        this.parentSub = this.right.parentSub
      }
    } else if (this.parent.constructor === ID) {
      const parentItem = getItem(store, this.parent)
      if (parentItem.constructor === GC) {
        this.parent = null
      } else {
        this.parent = /** @type {ContentType} */ (parentItem.content).type
      }
    }

    return null
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset
   */
  integrate (transaction, offset) {
    if (offset > 0) {
      this.id.clock += offset
      // 如果找不到，getItemCleanEnd()会强行拆分Item实例, this就是拆分出来的代表右半边的Item实例
      this.left = getItemCleanEnd(transaction, transaction.doc.store, createID(this.id.client, this.id.clock - 1))
      this.origin = this.left.lastId
      this.content = this.content.splice(offset)
      this.length -= offset
    }

    if (this.parent) {
      // 这个if判断是什么鬼逻辑?
      if ((!this.left && (!this.right || this.right.left !== null)) || (this.left && this.left.right !== this.right)) {
        /**
         * @type {Item|null}
         */
        let left = this.left

        /**
         * @type {Item|null}
         */
        let o
        // set o to the first conflicting item
        if (left !== null) {
          o = left.right
        } else if (this.parentSub !== null) {
          // 如果此Item对象是ymap里的, 则从value这个表尾指针一直向左遍历找到表头
          o = /** @type {AbstractType<any>} */ (this.parent)._map.get(this.parentSub) || null
          while (o !== null && o.left !== null) {
            o = o.left
          }
        } else {
          o = /** @type {AbstractType<any>} */ (this.parent)._start
        }


        /***** 开始 解决冲突(conflict resolution)  *****/

        // TODO: use something like DeleteSet here (a tree implementation would be best)
        // @todo use global set definitions
        /**
         * @type {Set<Item>}
         */
        const conflictingItems = new Set()
        /**
         * @type {Set<Item>}
         */
        const itemsBeforeOrigin = new Set()

        // 下面两行注释完全看不懂...
        // Let c in conflictingItems, b in itemsBeforeOrigin
        // ***{origin}bbbb{this}{c,b}{c,b}{o}***

        // Note that conflictingItems is a subset of itemsBeforeOrigin

        // 从此item的left指针遍历到right指针, 在这个区间的item都是和此item有可能发生冲突的
        while (o !== null && o !== this.right) {
          itemsBeforeOrigin.add(o)
          conflictingItems.add(o)
          if (compareIDs(this.origin, o.origin)) { // 冲突情况1: 此Item和o的origin相等, 发生冲突
            // case 1
            if (o.id.client < this.id.client) {
              // 通过对比client id的大小, 发现o的client id比此Item的小，则此Item的left指针指向o, 即此Item在o右边, 冲突解决
              left = o
              conflictingItems.clear()
            } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {  
              // 此Item的client id比o的小, 此Item本应放在o左边, 即此Item的rightOrigin至少为o
              // 但是满足了这个条件, 又说明此Item和o的rightOrigin是相等的, Item又应该在o的左边, 所以这个冲突无法解决, 并且再遍历到right指针也没有意义, 所以break跳出while循环

              // this and o are conflicting and point to the same integration points. The id decides which item comes first.
              // Since this is to the left of o, we can break here
              break
            } 
            // else, o might be integrated before an item that this conflicts with. If so, we will find it in the next iterations
            // 继续white循环遍历下一个item，把冲突解决寄希望于以后
          } else if (o.origin !== null && itemsBeforeOrigin.has(getItem(transaction.doc.store, o.origin))) { // use getItem instead of getItemCleanEnd because we don't want / need to split items.
            // 冲突情况2: 此Item和o的origin发生交叉，发生冲突。也就是o.origin所命中的Item实例，被包含在itemsBeforeOrigin里
            // 这种情况将o放在此Item左边，即此item的left指针指向o, 冲突解决

            // case 2
            if (!conflictingItems.has(getItem(transaction.doc.store, o.origin))) {
              left = o
              conflictingItems.clear()
            }
          } else {
            break
          }

          o = o.right
        }

        this.left = left
      }

      /***** 结束 解决冲突(conflict resolution) *****/

      // reconnect left/right + update parent map/start if necessary
      if (this.left !== null) {
        // 把此Item对象链接到parent的双向链表里
        const right = this.left.right
        this.right = right
        this.left.right = this
      } else {
        let r
        if (this.parentSub !== null) {
          // 把此Item对象放到ymap的value双向链表的表头
          r = /** @type {AbstractType<any>} */ (this.parent)._map.get(this.parentSub) || null
          while (r !== null && r.left !== null) {
            r = r.left
          }
        } else {
          // 把该Item对象插入到链表头
          r = /** @type {AbstractType<any>} */ (this.parent)._start
          ;/** @type {AbstractType<any>} */ (this.parent)._start = this
        }
        this.right = r
      }

      if (this.right !== null) {
        this.right.left = this
      } else if (this.parentSub !== null) {
        // set as current parent value if right === null and this is parentSub
        // 尾指针指向 代表key的当前值的Item对象
        /** @type {AbstractType<any>} */ (this.parent)._map.set(this.parentSub, this)
        if (this.left !== null) {
          // this is the current attribute value of parent. delete right
          // 前一个历史值成为墓碑
          this.left.delete(transaction)
        }
      }

      // adjust length of parent
      if (this.parentSub === null && this.countable && !this.deleted) {
        /** @type {AbstractType<any>} */ (this.parent)._length += this.length
      }

      // 把此Item对象链接于文档序的双向链表之后, 再将其放入插入序的StructStore中
      addStruct(transaction.doc.store, this)

      // 再将Item对象的content进行integrate, 最终会将对应的ytype进行_integrate
      this.content.integrate(transaction, this)

      // add parent to transaction.changed
      // 尝试把parent加入到transaction.changed里
      addChangedTypeToTransaction(transaction, /** @type {AbstractType<any>} */ (this.parent), this.parentSub)

      if ((/** @type {AbstractType<any>} */ (this.parent)._item !== null && /** @type {AbstractType<any>} */ (this.parent)._item.deleted)
        ||  (this.parentSub !== null && this.right !== null)) {
        // 第一个条件表示parent是yarray并且yarray已经标记为删除了
        // 第二个条件表示parent是ymap并且此Item对象不在表尾, 也就是说不是key的当前值

        // delete if parent is deleted or if this is not the current attribute value of parent
        this.delete(transaction)
      }
    } else {
      // parent is not defined. Integrate GC struct instead
      new GC(this.id, this.length).integrate(transaction, 0)
    }
  }

  // next()和prev()方法用于查找下一个和上一个未删除的Item
  // 也就说明Item是以双向链表连接的

  /**
   * Returns the next non-deleted item
   */
  get next () {
    let n = this.right
    while (n !== null && n.deleted) {
      n = n.right
    }
    return n
  }

  /**
   * Returns the previous non-deleted item
   */
  get prev () {
    let n = this.left
    while (n !== null && n.deleted) {
      n = n.left
    }
    return n
  }

  /**
   * Computes the last content address of this Item.
   */
  get lastId () {
    // allocating ids is pretty costly because of the amount of ids created, so we try to reuse whenever possible

    // 这里之所以要减1，是因为this.id.clock + this.length是下一个Item的clock值
    // 所以这个lastId是一个虚拟的ID, 并不和实际的Item对象关联
    return this.length === 1 ? this.id : createID(this.id.client, this.id.clock + this.length - 1)
  }

  /**
   * Try to merge two items
   *
   * @param {Item} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (
      this.constructor === right.constructor &&
      compareIDs(right.origin, this.lastId) &&
      this.right === right &&
      compareIDs(this.rightOrigin, right.rightOrigin) &&
      this.id.client === right.id.client &&
      this.id.clock + this.length === right.id.clock &&
      this.deleted === right.deleted &&
      this.redone === null &&
      right.redone === null &&
      this.content.constructor === right.content.constructor &&
      this.content.mergeWith(right.content)
    ) {
      const searchMarker = /** @type {AbstractType<any>} */ (this.parent)._searchMarker

      if (searchMarker) {
        searchMarker.forEach(marker => {
          if (marker.p === right) {
            // right is going to be "forgotten" so we need to update the marker
            marker.p = this
            // adjust marker index
            if (!this.deleted && this.countable) {
              // 这里为什么要减去this.length而不是加上this.length呢?
              marker.index -= this.length
            }
          }
        })
      }

      // 继承right的keep属性
      if (right.keep) {
        this.keep = true
      }

      // 重新调整双向链表中的指针
      this.right = right.right

      if (this.right !== null) {
        this.right.left = this
      }

      this.length += right.length

      // 返回true表示merge成功
      return true
    }

    // 返回false表示merge失败
    return false
  }

  /**
   * Mark this Item as deleted.
   *
   * @param {Transaction} transaction
   */
  delete (transaction) {
    if (!this.deleted) {
      const parent = /** @type {AbstractType<any>} */ (this.parent)

      // adjust the length of parent
      // parentSub为null, 说明此Item是yarray里的元素
      if (this.countable && this.parentSub === null) {
        parent._length -= this.length
      }

      this.markDeleted()

      // 为什么要在transaction里维护一个deleteSet?
      // 因为在transaction里新增和修改的Item对象，已经integrate到了doc的StructStore里, 所以要单独维护一个deleteSet来记录哪些Item对象是被删除的
      addToDeleteSet(transaction.deleteSet, this.id.client, this.id.clock, this.length)
      addChangedTypeToTransaction(transaction, parent, this.parentSub)

      // 只有ContentType和ContentDoc这两种类型实现了delete()方法,其他Content类型的delete()方法都是空实现
      this.content.delete(transaction)
    }
  }

  /**
   * @param {StructStore} store
   * @param {boolean} parentGCd
   *
   * parentGCd表示GC的方式
   * 即是将本Item实例替换为GC实例, 还是只是将Item.content替换为ContentDeleted实例
   *
   */
  gc (store, parentGCd) {
    if (!this.deleted) {
      throw error.unexpectedCase()
    }

    this.content.gc(store)

    if (parentGCd) {
      replaceStruct(store, this, new GC(this.id, this.length))
    } else {
      this.content = new ContentDeleted(this.length)
    }
  }

  /**
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
   * @param {number} offset
   */
  write (encoder, offset) {
    const origin = offset > 0 ? createID(this.id.client, this.id.clock + offset - 1) : this.origin
    const rightOrigin = this.rightOrigin
    const parentSub = this.parentSub
    const info = (this.content.getRef() & binary.BITS5) |
      (origin === null ? 0 : binary.BIT8) | // origin is defined
      (rightOrigin === null ? 0 : binary.BIT7) | // right origin is defined
      (parentSub === null ? 0 : binary.BIT6) // parentSub is non-null
    encoder.writeInfo(info)

    // 写入3个值: origin/rightOrigin/content
    if (origin !== null) {
      encoder.writeLeftID(origin)
    }
    if (rightOrigin !== null) {
      encoder.writeRightID(rightOrigin)
    }
    if (origin === null && rightOrigin === null) {
      const parent = /** @type {AbstractType<any>} */ (this.parent)
      if (parent._item !== undefined) {
        const parentItem = parent._item
        if (parentItem === null) {
          // parent type on y._map
          // find the correct key
          const ykey = findRootTypeKey(parent)
          encoder.writeParentInfo(true) // write parentYKey
          encoder.writeString(ykey)
        } else {
          encoder.writeParentInfo(false) // write parent id
          encoder.writeLeftID(parentItem.id)
        }
      } else if (parent.constructor === String) { // this edge case was added by differential updates
        encoder.writeParentInfo(true) // write parentYKey
        encoder.writeString(parent)
      } else if (parent.constructor === ID) {
        encoder.writeParentInfo(false) // write parent id
        encoder.writeLeftID(parent)
      } else {
        error.unexpectedCase()
      }
      if (parentSub !== null) {
        encoder.writeString(parentSub)
      }
    }
    this.content.write(encoder, offset)
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @param {number} info
 * 根据info的低5位，选择对应的contentRefs中的函数来调用
 */
export const readItemContent = (decoder, info) => contentRefs[info & binary.BITS5](decoder)

/**
 * A lookup map for reading Item content.
 *
 * @type {Array<function(UpdateDecoderV1 | UpdateDecoderV2):AbstractContent>}
 */
export const contentRefs = [
  // 这里0到10也就是ContentXXX类型的getRef()方法的返回值
  () => { error.unexpectedCase() }, // GC is not ItemContent
  readContentDeleted, // 1
  readContentJSON, // 2
  readContentBinary, // 3
  readContentString, // 4
  readContentEmbed, // 5
  readContentFormat, // 6
  readContentType, // 7
  readContentAny, // 8
  readContentDoc, // 9
  () => { error.unexpectedCase() } // 10 - Skip is not ItemContent
]

/**
 * Do not implement this class!
 */
export class AbstractContent {
  /**
   * @return {number}
   */
  getLength () {
    throw error.methodUnimplemented()
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    throw error.methodUnimplemented()
  }

  /**
   * Should return false if this Item is some kind of meta information
   * (e.g. format information).
   *
   * * Whether this Item should be addressable via `yarray.get(i)`
   * * Whether this Item should be counted when computing yarray.length
   *
   * 上面两行解释了isCountable()的语义
   * 目前AbstractContent的子类里，ContentDeleted和ContentFormat返回false，其他都返回true
   * @return {boolean}
   */
  isCountable () {
    throw error.methodUnimplemented()
  }

  /**
   * @return {AbstractContent}
   */
  copy () {
    throw error.methodUnimplemented()
  }

  /**
   * @param {number} _offset
   * @return {AbstractContent}
   */
  splice (_offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {AbstractContent} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} _item
   */
  integrate (_transaction, _item) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} _transaction
   */
  delete (_transaction) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {StructStore} _store
   */
  gc (_store) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder
   * @param {number} _offset
   */
  write (_encoder, _offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @return {number}
   */
  getRef () {
    throw error.methodUnimplemented()
  }
}
