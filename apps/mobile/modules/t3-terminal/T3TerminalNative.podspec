require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3TerminalNative'
  s.version = package['version']
  s.summary = 'Native terminal surface for Akeru Bot mobile.'
  s.description = 'Native terminal surface bridge used by the Akeru Bot React Native app.'
  s.homepage = 'https://github.com/opencoredev/akeru-bot'
  s.license = { :type => 'MIT', :file => 'LICENSE' }
  s.author = 'Akeru Bot maintainers'
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.vendored_frameworks = 'Vendor/libghostty/GhosttyKit.xcframework'
  s.frameworks = 'IOSurface', 'Metal', 'MetalKit', 'QuartzCore', 'UIKit'
  s.libraries = 'c++', 'z'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
