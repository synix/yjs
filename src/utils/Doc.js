/**
 * @module Y
 */

import {
  StructStore,
  AbstractType,
  YArray,
  YText,
  YMap,
  YXmlElement,
  YXmlFragment,
  transact,
  ContentDoc, Item, Transaction, YEvent // eslint-disable-line
} from '../internals.js'

import { ObservableV2 } from 'lib0/observable'
import * as random from 'lib0/random'
import * as map from 'lib0/map'
import * as array from 'lib0/array'
import * as promise from 'lib0/promise'

export const generateNewClientId = random.uint32

/**
 * @typedef {Object} DocOpts
 * @property {boolean} [DocOpts.gc=true] Disable garbage collection (default: gc=true)
 * @property {function(Item):boolean} [DocOpts.gcFilter] Will be called before an Item is garbage collected. Return false to keep the Item.
 * @property {string} [DocOpts.guid] Define a globally unique identifier for this document
 * @property {string | null} [DocOpts.collectionid] Associate this document with a collection. This only plays a role if your provider has a concept of collection.
 * @property {any} [DocOpts.meta] Any kind of meta information you want to associate with this document. If this is a subdocument, remote peers will store the meta information as well.
 * @property {boolean} [DocOpts.autoLoad] If a subdocument, automatically load document. If this is a subdocument, remote peers will load the document as well automatically.
 * @property {boolean} [DocOpts.shouldLoad] Whether the document should be synced by the provider now. This is toggled to true when you call ydoc.load()
 */


// See https://docs.yjs.dev/api/y.doc#event-handler 👇

/**
 * @typedef {Object} DocEvents
 * @property {function(Doc):void} DocEvents.destroy
 * @property {function(Doc):void} DocEvents.load
 * @property {function(boolean, Doc):void} DocEvents.sync
 * @property {function(Uint8Array, any, Doc, Transaction):void} DocEvents.update
 * @property {function(Uint8Array, any, Doc, Transaction):void} DocEvents.updateV2
 * @property {function(Doc):void} DocEvents.beforeAllTransactions
 * @property {function(Transaction, Doc):void} DocEvents.beforeTransaction
 * @property {function(Transaction, Doc):void} DocEvents.beforeObserverCalls
 * @property {function(Transaction, Doc):void} DocEvents.afterTransaction
 * @property {function(Transaction, Doc):void} DocEvents.afterTransactionCleanup
 * @property {function(Doc, Array<Transaction>):void} DocEvents.afterAllTransactions
 * @property {function({ loaded: Set<Doc>, added: Set<Doc>, removed: Set<Doc> }, Doc, Transaction):void} DocEvents.subdocs
 */

/**
 * A Yjs instance handles the state of shared data.
 * 
 * 继承了ObservableV2，也就具备了on()/off()/once()等事件监听方法，以及emit()发送事件方法
 * 支持的事件如DocEvents所定义，包括destroy/load/sync/update/updateV2等
 * 除了load/destroy这两个事件在Doc里触发，其他事件都是在Transaction里触发的
 * 
 * @extends ObservableV2<DocEvents>
 */
export class Doc extends ObservableV2 {
  /**
   * @param {DocOpts} opts configuration
   */
  constructor ({ guid = random.uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true } = {}) {
    super()
    this.gc = gc

    // gc在调用tryGcDeleteSet()函数, 在回收Item对象之前会调用gcFilter(), 如果返回false则不回收
    this.gcFilter = gcFilter
    this.clientID = generateNewClientId()
    this.guid = guid
    this.collectionid = collectionid
    /**
     * @type {Map<string, AbstractType<YEvent<any>>>}
     * 这个share是一个Map，key是name，value是AbstractType实例
     * 也就是说，这个Map存储了所有底层的AbstractType实例
     */
    this.share = new Map()

    /* 依据逻辑时序(即insertion order)对Item实例进行建模 */
    this.store = new StructStore()
    /**
     * @type {Transaction | null}
     * 
     * 表示当前正在进行的transaction
     */
    this._transaction = null
    /**
     * @type {Array<Transaction>}
     */
    this._transactionCleanups = []
    /**
     * @type {Set<Doc>}
     */
    this.subdocs = new Set()
    /**
     * If this document is a subdocument - a document integrated into another document - then _item is defined.
     * 
     * 也就是说，如果这个Doc是一个subdoc，那么_item就是这个subdoc在父doc中的Item??
     * @type {Item?}
     */
    this._item = null
    this.shouldLoad = shouldLoad
    this.autoLoad = autoLoad
    this.meta = meta
    /**
     * This is set to true when the persistence provider loaded the document from the database or when the `sync` event fires.
     * Note that not all providers implement this feature. Provider authors are encouraged to fire the `load` event when the doc content is loaded from the database.
     *
     * 与persistence provider有关，当provider从数据库加载文档到内存时，这个值会被设置为true
     * 
     * @type {boolean}
     */
    this.isLoaded = false
    /**
     * This is set to true when the connection provider has successfully synced with a backend.
     * Note that when using peer-to-peer providers this event may not provide very useful.
     * Also note that not all providers implement this feature. Provider authors are encouraged to fire
     * the `sync` event when the doc has been synced (with `true` as a parameter) or if connection is
     * lost (with false as a parameter).
     * 
     * 与connection provider有关，当provider与后端完成同步时，这个值会被设置为true
     */
    this.isSynced = false
    this.isDestroyed = false
    /**
      * Promise that resolves once the document has been loaded from a persistence provider.
      * 也就是说，如果外界发现 this.isLoaded 为false，那就可以 await this.whenLoaded 等待加载完成
     */
    this.whenLoaded = promise.create(resolve => {
      this.on('load', () => {
        this.isLoaded = true
        resolve(this)
      })
    })

    const provideSyncedPromise = () => promise.create(resolve => {
      /**
       * @param {boolean} isSynced
       */
      const eventHandler = (isSynced) => {
        // sync事件触发时，如果isSynced为undefined或者true，那么都认为是同步完成
        if (isSynced === undefined || isSynced === true) {
          this.off('sync', eventHandler)
          resolve()
        }
      }
      this.on('sync', eventHandler)
    })

    this.on('sync', isSynced => {
      // 监听sync事件，如果isSynced为false(代表此时连接丢失)，并且this.isSynced为true(代表曾经连接并完成同步过), 那么重新创建一个this.whenSynced
      if (isSynced === false && this.isSynced) {
        this.whenSynced = provideSyncedPromise()
      }
      this.isSynced = isSynced === undefined || isSynced === true

      // 如果isSynced为true，且this.isLoaded为false，那么触发load事件
      if (this.isSynced && !this.isLoaded) {
        this.emit('load', [this])
      }
    })

    /**
     * Promise that resolves once the document has been synced with a backend.
     * This promise is recreated when the connection is lost.
     * Note the documentation about the `isSynced` property.
     * 
     * 也就是说，如果外界发现 this.isSynced 为false，那就可以 await this.whenSynced 等待连接恢复
     */
    this.whenSynced = provideSyncedPromise()
  }

  /**
   * Notify the parent document that you request to load data into this subdocument (if it is a subdocument).
   *
   * `load()` might be used in the future to request any provider to load the most current data.
   *
   * It is safe to call `load()` multiple times.
   */
  load () {
    const item = this._item
    if (item !== null && !this.shouldLoad) {
      transact(/** @type {any} */ (item.parent).doc, transaction => {
        transaction.subdocsLoaded.add(this)
      }, null, true)
    }
    this.shouldLoad = true
  }

  getSubdocs () {
    return this.subdocs
  }

  getSubdocGuids () {
    return new Set(array.from(this.subdocs).map(doc => doc.guid))
  }

  /**
   * Changes that happen inside of a transaction are bundled. This means that
   * the observer fires _after_ the transaction is finished and that all changes
   * that happened inside of the transaction are sent as one message to the
   * other peers.
   *
   * @template T
   * @param {function(Transaction):T} f The function that should be executed as a transaction
   * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
   * @return T
   *
   * @public
   */
  transact (f, origin = null) {
    return transact(this, f, origin)
  }

  /**
   * Define a shared data type.
   *
   * Multiple calls of `ydoc.get(name, TypeConstructor)` yield the same result
   * and do not overwrite each other. I.e.
   * `ydoc.get(name, Y.Array) === ydoc.get(name, Y.Array)`
   *
   * After this method is called, the type is also available on `ydoc.share.get(name)`.
   *
   * *Best Practices:*
   * Define all types right after the Y.Doc instance is created and store them in a separate object.
   * Also use the typed methods `getText(name)`, `getArray(name)`, ..
   *
   * @template {typeof AbstractType<any>} Type
   * @example
   *   const ydoc = new Y.Doc(..)
   *   const appState = {
   *     document: ydoc.getText('document')
   *     comments: ydoc.getArray('comments')
   *   }
   *
   * @param {string} name
   * @param {Type} TypeConstructor The constructor of the type definition. E.g. Y.Text, Y.Array, Y.Map, ...
   * @return {InstanceType<Type>} The created type. Constructed with TypeConstructor
   *
   * @public
   */
  get (name, TypeConstructor = /** @type {any} */ (AbstractType)) {
    // get()方法的核心是下面这行代码...
    const type = map.setIfUndefined(this.share, name, () => {
      // @ts-ignore
      const t = new TypeConstructor()
      t._integrate(this, null)
      return t
    })

    // Constr代表name实际的类型
    const Constr = type.constructor
    // TypeConstructor代表name传入的类型

    // 什么情况下这个if会成立呢？
    // name实际的类型(Constr)是AbstractType，而name传入的类型(TypeConstructor)是YType
    if (TypeConstructor !== AbstractType && Constr !== TypeConstructor) {
      // 
      if (Constr === AbstractType) {
        // 如果name已经被定义过了, 并且使用了AbstractType，而不是某个YType类型, 则使用YType把这个实例重建一下
        // @ts-ignore
        const t = new TypeConstructor()

        // ytype._map里每个value的parent都指向了ytype
        t._map = type._map
        type._map.forEach(/** @param {Item?} n */ n => {
          for (; n !== null; n = n.left) {
            // @ts-ignore
            n.parent = t
          }
        })

        // ytype._start双向链表里每个元素的parent都指向了ytype
        t._start = type._start
        for (let n = t._start; n !== null; n = n.right) {
          n.parent = t
        }
        t._length = type._length

        this.share.set(name, t)
        t._integrate(this, null)
        return /** @type {InstanceType<Type>} */ (t)
      } else {
        throw new Error(`Type with the name ${name} has already been defined with a different constructor`)
      }
    }

    return /** @type {InstanceType<Type>} */ (type)
  }

  /**
   * @template T
   * @param {string} [name]
   * @return {YArray<T>}
   *
   * @public
   */
  getArray (name = '') {
    return /** @type {YArray<T>} */ (this.get(name, YArray))
  }

  /**
   * @param {string} [name]
   * @return {YText}
   *
   * @public
   */
  getText (name = '') {
    return this.get(name, YText)
  }

  /**
   * @template T
   * @param {string} [name]
   * @return {YMap<T>}
   *
   * @public
   */
  getMap (name = '') {
    return /** @type {YMap<T>} */ (this.get(name, YMap))
  }

  /**
   * @param {string} [name]
   * @return {YXmlElement}
   *
   * @public
   */
  getXmlElement (name = '') {
    return /** @type {YXmlElement<{[key:string]:string}>} */ (this.get(name, YXmlElement))
  }

  /**
   * @param {string} [name]
   * @return {YXmlFragment}
   *
   * @public
   */
  getXmlFragment (name = '') {
    return this.get(name, YXmlFragment)
  }

  /**
   * Converts the entire document into a js object, recursively traversing each yjs type
   * Doesn't log types that have not been defined (using ydoc.getType(..)).
   *
   * @deprecated Do not use this method and rather call toJSON directly on the shared types.
   *
   * @return {Object<string, any>}
   */
  toJSON () {
    /**
     * @type {Object<string, any>}
     */
    const doc = {}

    this.share.forEach((value, key) => {
      doc[key] = value.toJSON()
    })

    return doc
  }

  /**
   * Emit `destroy` event and unregister all event handlers.
   */
  destroy () {
    // 首先是处理subdocs
    // 先把所有的subdoc都destroy掉
    this.isDestroyed = true
    array.from(this.subdocs).forEach(subdoc => subdoc.destroy())
    const item = this._item
    if (item !== null) {
      this._item = null
      const content = /** @type {ContentDoc} */ (item.content)
      content.doc = new Doc({ guid: this.guid, ...content.opts, shouldLoad: false })
      content.doc._item = item
      transact(/** @type {any} */ (item).parent.doc, transaction => {
        const doc = content.doc
        if (!item.deleted) {
          transaction.subdocsAdded.add(doc)
        }
        transaction.subdocsRemoved.add(this)
      }, null, true)
    }

    // @ts-ignore
    this.emit('destroyed', [true]) // DEPRECATED!

    // 触发destroy事件
    this.emit('destroy', [this])

    // 这里调用了ObservableV2的destroy()方法，清除其_observers也就是unregister all event handlers
    super.destroy()
  }
}
