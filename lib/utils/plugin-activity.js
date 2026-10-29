function observeInstance(instance, onHandled) {
  const wrapped = new Set()
  const wrap = name => {
    if (typeof name !== "string" || wrapped.has(name) || typeof instance[name] !== "function") return
    const original = instance[name]
    const descriptor = Object.getOwnPropertyDescriptor(instance, name)
    if (descriptor && !descriptor.configurable && !descriptor.writable || descriptor === undefined && !Object.isExtensible(instance)) return
    wrapped.add(name)
    Object.defineProperty(instance, name, {
      configurable: descriptor?.configurable ?? true,
      writable: descriptor?.writable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      value: function (...args) {
        onHandled()
        return original.apply(this, args)
      },
    })
  }

  wrap("accept")
  for (const rule of instance.rule || []) wrap(rule?.fnc)
  if (typeof instance.getContext === "function") {
    const original = instance.getContext
    const descriptor = Object.getOwnPropertyDescriptor(instance, "getContext")
    if (!(descriptor && !descriptor.configurable && !descriptor.writable || descriptor === undefined && !Object.isExtensible(instance))) {
      Object.defineProperty(instance, "getContext", {
        configurable: descriptor?.configurable ?? true,
        writable: descriptor?.writable ?? true,
        enumerable: descriptor?.enumerable ?? false,
        value: function (...args) {
          const context = original.apply(this, args)
          for (const name of Object.keys(context || {})) wrap(name)
          return context
        },
      })
    }
  }
  return instance
}

export function dispatchWithPluginActivity(loader, event, onHandled) {
  let handled = false
  const markHandled = () => {
    if (handled) return
    handled = true
    try { onHandled() } catch {}
  }
  const localLoader = Object.create(loader)
  localLoader.priority = (loader.priority || []).map(entry => {
    if (typeof entry?.class !== "function") return entry
    return {
      ...entry,
      class: new Proxy(entry.class, {
        construct(target, args) {
          return observeInstance(Reflect.construct(target, args), markHandled)
        },
      }),
    }
  })
  return localLoader.deal(event)
}
