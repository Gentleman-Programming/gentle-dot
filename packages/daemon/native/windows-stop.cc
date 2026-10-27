// App-channel-only entry point; the stop listener (createStopListener) joins
// this module in a later PR.
#include "windows-app-channel-napi.h"

namespace {
napi_value Init(napi_env env, napi_value exports) {
  if (gentle_dot::app_channel::RegisterAppChannel(env, exports) != napi_ok) return nullptr;
  return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
