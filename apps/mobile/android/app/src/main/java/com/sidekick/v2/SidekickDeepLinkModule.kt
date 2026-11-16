package com.sidekick.v2

import android.content.Intent
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager

object SidekickDeepLinkStore {
  @Volatile private var initialUrl: String? = null
  @Volatile private var latestUrl: String? = null

  fun remember(intent: Intent?) {
    val url = intent?.dataString?.trim().orEmpty()
    if (url.isBlank()) return
    if (initialUrl == null) initialUrl = url
    latestUrl = url
  }

  fun initial(): String? = initialUrl

  fun latest(): String? = latestUrl

  fun consumeLatest(): String? {
    val url = latestUrl
    latestUrl = null
    return url
  }
}

@ReactModule(name = SidekickDeepLinkModule.NAME)
class SidekickDeepLinkModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  companion object {
    const val NAME = "SidekickDeepLink"
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun getInitialUrl(promise: Promise) {
    promise.resolve(SidekickDeepLinkStore.initial())
  }

  @ReactMethod
  fun peekLatestUrl(promise: Promise) {
    promise.resolve(SidekickDeepLinkStore.latest())
  }

  @ReactMethod
  fun consumeLatestUrl(promise: Promise) {
    promise.resolve(SidekickDeepLinkStore.consumeLatest())
  }
}

class SidekickDeepLinkPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return when (name) {
      SidekickDeepLinkModule.NAME -> SidekickDeepLinkModule(reactContext)
      else -> null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    val moduleInfo = ReactModuleInfo(
      SidekickDeepLinkModule.NAME,
      SidekickDeepLinkModule::class.java.name,
      true,
      false,
      false,
      false,
    )
    return ReactModuleInfoProvider { mapOf(SidekickDeepLinkModule.NAME to moduleInfo) }
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
