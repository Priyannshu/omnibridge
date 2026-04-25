{
  "targets": [
    {
      "target_name": "omnibridge_dragdrop",
      "sources": [ "src/dragdrop.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      },
      "defines": [ "NAPI_CPP_EXCEPTIONS" ],
      "libraries": [
        "Ole32.lib",
        "Shell32.lib"
      ]
    }
  ]
}
