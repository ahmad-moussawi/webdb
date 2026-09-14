#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include <unordered_map>
#include <algorithm>
#include <type_traits>

namespace webdb::vfs {

/**
 * @brief File open flags for the Virtual File System.
 * Supported bitwise combinations determine read/write access and creation semantics.
 */
enum class OpenMode : uint32_t {
    Read     = 1 << 0,
    Write    = 1 << 1,
    Create   = 1 << 2,
    Truncate = 1 << 3,
    ReadWrite = Read | Write
};

constexpr OpenMode operator|(OpenMode lhs, OpenMode rhs) noexcept {
    using Underlying = std::underlying_type_t<OpenMode>;
    return static_cast<OpenMode>(static_cast<Underlying>(lhs) | static_cast<Underlying>(rhs));
}

constexpr OpenMode operator&(OpenMode lhs, OpenMode rhs) noexcept {
    using Underlying = std::underlying_type_t<OpenMode>;
    return static_cast<OpenMode>(static_cast<Underlying>(lhs) & static_cast<Underlying>(rhs));
}

constexpr bool has_flag(OpenMode value, OpenMode flag) noexcept {
    return (value & flag) == flag;
}

/**
 * @brief Handle representing an open file within the VFS.
 */
using FileHandle = int32_t;
inline constexpr FileHandle INVALID_FILE_HANDLE = -1;

/**
 * @brief Pure abstract interface defining the Virtual File System (VFS).
 *
 * This abstraction decouples database page storage from native filesystem
 * implementations, allowing seamless portability between in-memory structures,
 * browser-native Origin Private File System (OPFS), or native POSIX backends.
 */
class IVirtualFileSystem {
public:
    virtual ~IVirtualFileSystem() = default;

    /**
     * @brief Opens or creates a file at the given path.
     * @param path Relative or absolute path identifier.
     * @param mode Combination of OpenMode flags.
     * @return Valid FileHandle on success, or INVALID_FILE_HANDLE on failure.
     */
    virtual FileHandle open(const std::string& path, OpenMode mode) = 0;

    /**
     * @brief Reads bytes from an open file at a specific offset.
     * @param handle Active file descriptor.
     * @param buffer Destination memory buffer.
     * @param size Number of bytes to read.
     * @param offset Absolute offset in bytes from the beginning of the file.
     * @return Number of bytes actually read, or -1 on error.
     */
    virtual int64_t read(FileHandle handle, void* buffer, size_t size, size_t offset) = 0;

    /**
     * @brief Writes bytes to an open file at a specific offset.
     * @param handle Active file descriptor.
     * @param buffer Source memory buffer.
     * @param size Number of bytes to write.
     * @param offset Absolute offset in bytes from the beginning of the file.
     * @return Number of bytes actually written, or -1 on error.
     */
    virtual int64_t write(FileHandle handle, const void* buffer, size_t size, size_t offset) = 0;

    /**
     * @brief Closes an open file descriptor.
     * @param handle Active file descriptor.
     * @return True if successfully closed, false otherwise.
     */
    virtual bool close(FileHandle handle) = 0;

    /**
     * @brief Retrieves the current size of an open file in bytes.
     * @param handle Active file descriptor.
     * @return File size in bytes, or -1 on error.
     */
    virtual int64_t get_size(FileHandle handle) const = 0;

    /**
     * @brief Checks if a file exists at the specified path.
     * @param path Path to verify.
     * @return True if the file exists, false otherwise.
     */
    virtual bool exists(const std::string& path) const = 0;

    /**
     * @brief Deletes a file from the filesystem.
     * @param path Path of the file to remove.
     * @return True if deleted successfully, false otherwise.
     */
    virtual bool remove(const std::string& path) = 0;
};

/**
 * @brief Concrete in-memory implementation of IVirtualFileSystem.
 *
 * Stores all files as contiguous dynamic byte buffers in memory.
 * Completely free of OS file stream dependencies or threading primitives.
 */
class InMemoryFileSystem final : public IVirtualFileSystem {
public:
    InMemoryFileSystem() = default;
    ~InMemoryFileSystem() override = default;

    FileHandle open(const std::string& path, OpenMode mode) override {
        const bool exists = files_.contains(path);

        if (!exists) {
            if (!has_flag(mode, OpenMode::Create)) {
                return INVALID_FILE_HANDLE;
            }
            files_[path] = std::vector<uint8_t>{};
        } else if (has_flag(mode, OpenMode::Truncate)) {
            files_[path].clear();
        }

        const FileHandle handle = next_handle_++;
        open_handles_[handle] = OpenFileDescriptor{
            .path = path,
            .mode = mode
        };

        return handle;
    }

    int64_t read(FileHandle handle, void* buffer, size_t size, size_t offset) override {
        if (!buffer || size == 0) {
            return 0;
        }

        auto desc_it = open_handles_.find(handle);
        if (desc_it == open_handles_.end()) {
            return -1;
        }

        if (!has_flag(desc_it->second.mode, OpenMode::Read)) {
            return -1;
        }

        auto file_it = files_.find(desc_it->second.path);
        if (file_it == files_.end()) {
            return -1;
        }

        const auto& file_data = file_it->second;
        if (offset >= file_data.size()) {
            return 0; // EOF reached
        }

        const size_t bytes_available = file_data.size() - offset;
        const size_t bytes_to_copy = std::min(size, bytes_available);

        std::copy_n(file_data.data() + offset, bytes_to_copy, static_cast<uint8_t*>(buffer));
        return static_cast<int64_t>(bytes_to_copy);
    }

    int64_t write(FileHandle handle, const void* buffer, size_t size, size_t offset) override {
        if (!buffer || size == 0) {
            return 0;
        }

        auto desc_it = open_handles_.find(handle);
        if (desc_it == open_handles_.end()) {
            return -1;
        }

        if (!has_flag(desc_it->second.mode, OpenMode::Write)) {
            return -1;
        }

        auto file_it = files_.find(desc_it->second.path);
        if (file_it == files_.end()) {
            return -1;
        }

        auto& file_data = file_it->second;
        const size_t required_size = offset + size;
        if (required_size > file_data.size()) {
            file_data.resize(required_size, 0);
        }

        const auto* src_bytes = static_cast<const uint8_t*>(buffer);
        std::copy_n(src_bytes, size, file_data.data() + offset);

        return static_cast<int64_t>(size);
    }

    bool close(FileHandle handle) override {
        auto desc_it = open_handles_.find(handle);
        if (desc_it == open_handles_.end()) {
            return false;
        }
        open_handles_.erase(desc_it);
        return true;
    }

    int64_t get_size(FileHandle handle) const override {
        auto desc_it = open_handles_.find(handle);
        if (desc_it == open_handles_.end()) {
            return -1;
        }

        auto file_it = files_.find(desc_it->second.path);
        if (file_it == files_.end()) {
            return -1;
        }

        return static_cast<int64_t>(file_it->second.size());
    }

    bool exists(const std::string& path) const override {
        return files_.contains(path);
    }

    bool remove(const std::string& path) override {
        auto file_it = files_.find(path);
        if (file_it == files_.end()) {
            return false;
        }

        // Close any active handles pointing to the removed file
        std::erase_if(open_handles_, [&](const auto& pair) {
            return pair.second.path == path;
        });

        files_.erase(file_it);
        return true;
    }

private:
    struct OpenFileDescriptor {
        std::string path;
        OpenMode mode;
    };

    FileHandle next_handle_{1};
    std::unordered_map<FileHandle, OpenFileDescriptor> open_handles_;
    std::unordered_map<std::string, std::vector<uint8_t>> files_;
};

} // namespace webdb::vfs
