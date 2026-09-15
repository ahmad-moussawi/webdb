#pragma once

#include <bit>
#include <cstdint>
#include <cstring>
#include <type_traits>

namespace webdb::endian {

template <typename T>
inline T read_le(const uint8_t* src) noexcept {
    static_assert(std::is_trivially_copyable_v<T>);

    T value;
    std::memcpy(&value, src, sizeof(T));

    if constexpr (std::endian::native == std::endian::big) {
        if constexpr (sizeof(T) == 2) {
            auto bits = std::bit_cast<uint16_t>(value);
            return std::bit_cast<T>(__builtin_bswap16(bits));
        } else if constexpr (sizeof(T) == 4) {
            auto bits = std::bit_cast<uint32_t>(value);
            return std::bit_cast<T>(__builtin_bswap32(bits));
        } else if constexpr (sizeof(T) == 8) {
            auto bits = std::bit_cast<uint64_t>(value);
            return std::bit_cast<T>(__builtin_bswap64(bits));
        }
    }

    return value;
}

template <typename T>
inline void write_le(uint8_t* dst, T value) noexcept {
    static_assert(std::is_trivially_copyable_v<T>);

    if constexpr (std::endian::native == std::endian::big) {
        if constexpr (sizeof(T) == 2) {
            auto bits = std::bit_cast<uint16_t>(value);
            value = std::bit_cast<T>(__builtin_bswap16(bits));
        } else if constexpr (sizeof(T) == 4) {
            auto bits = std::bit_cast<uint32_t>(value);
            value = std::bit_cast<T>(__builtin_bswap32(bits));
        } else if constexpr (sizeof(T) == 8) {
            auto bits = std::bit_cast<uint64_t>(value);
            value = std::bit_cast<T>(__builtin_bswap64(bits));
        }
    }

    std::memcpy(dst, &value, sizeof(T));
}

inline uint16_t read_uint16(const uint8_t* p) noexcept { return read_le<uint16_t>(p); }
inline uint32_t read_uint32(const uint8_t* p) noexcept { return read_le<uint32_t>(p); }
inline uint64_t read_uint64(const uint8_t* p) noexcept { return read_le<uint64_t>(p); }
inline int32_t read_int32(const uint8_t* p) noexcept { return read_le<int32_t>(p); }
inline int64_t read_int64(const uint8_t* p) noexcept { return read_le<int64_t>(p); }
inline double read_double(const uint8_t* p) noexcept { return read_le<double>(p); }

inline void write_uint16(uint8_t* p, uint16_t v) noexcept { write_le<uint16_t>(p, v); }
inline void write_uint32(uint8_t* p, uint32_t v) noexcept { write_le<uint32_t>(p, v); }
inline void write_uint64(uint8_t* p, uint64_t v) noexcept { write_le<uint64_t>(p, v); }
inline void write_int32(uint8_t* p, int32_t v) noexcept { write_le<int32_t>(p, v); }
inline void write_int64(uint8_t* p, int64_t v) noexcept { write_le<int64_t>(p, v); }
inline void write_double(uint8_t* p, double v) noexcept { write_le<double>(p, v); }

} // namespace webdb::endian
