#pragma once
#include <node_api.h>

namespace gentle_dot::app_channel {
// Registration only; importing the addon never adopts fd3 or starts I/O.
napi_status RegisterAppChannel(napi_env env, napi_value exports);
}  // namespace gentle_dot::app_channel
